// The .show file: one baked lighting sequence, self-contained.
//
// A bake is a flat recording of every pixel's colour, `fps` times a second. The client plays it by
// indexing with the server clock — frame = floor((serverNow − startAt) × fps) — so there is nothing
// to drift: position is recomputed from the clock on every tick, never accumulated.
//
// The file carries its own patch and authoring metadata, so a show Mac needs this
// one file and nothing else from the editor.
//
//   offset 0   "LBESHOW1"                       8 bytes, ASCII magic + format generation
//   offset 8   headerLength                     u32 little-endian, bytes of JSON that follow
//   offset 12  header JSON (UTF-8), space-padded so the frame data starts 8-byte aligned
//   then       frameCount × pixelCount × 3 samples, R G B per pixel, in frame order
//                bits = 8  → one byte per sample
//                bits = 16 → two bytes per sample, little-endian
//
// WHAT A SAMPLE MEANS. Samples are linear light encoded with a pure power curve: sample/max =
// light^(1/transfer), transfer = 2.2. That is deliberate, not incidental. Eight bits of *linear*
// light spends half its codes on the brightest stop and leaves a handful for the dark end, where
// fades live and where the eye is most sensitive; the same eight bits perceptually spaced are
// enough. The client decodes with the same exponent, applies master/cap in linear light, then each
// fixture's own drive curve (see output.ts). So brightness can be changed on site with no re-bake.
//
// fps and bits are per-file settings, not constants — 40fps/8-bit is the default, and a bake at
// 16-bit is the answer if dim fades step visibly on real fixtures.

import type { Patch } from "./patch";

export const SHOW_MAGIC = "LBESHOW1";
export const SHOW_VERSION = 1;
/** The exponent samples are encoded with. Recorded per file; this is what a bake writes. */
export const SHOW_TRANSFER = 2.2;
export const SHOW_EXTENSION = ".show";
/** Filename stem for the idle loop between sessions. */
export const AMBIENT_EXPERIENCE = "ambient";

export type SampleBits = 8 | 16;

export interface ShowHeader {
  version: number;
  /** The sequence's own name, for humans and logs. */
  name: string;
  /** Experience recorded by the author. The player assigns states by filename. */
  experience: string;
  fps: number;
  bits: SampleBits;
  pixelCount: number;
  frameCount: number;
  /** Exponent the samples are encoded with (see the header comment). */
  transfer: number;
  /** Loop instead of going dark after the last frame. The ambient show loops regardless. */
  loop?: boolean;
  patch: Patch;
  /** ISO timestamp of the bake. */
  bakedAt: string;
  /** What produced it, e.g. "lighting-editor 0.1.0" or "make-test-show". */
  bakedBy?: string;
  /** Content hashes of what was baked, so the editor can tell a bake is stale. Opaque to the client. */
  hashes?: { rig?: string; sequence?: string };
}

export interface ParsedShow {
  header: ShowHeader;
  /** Byte offset of frame 0 within the file. */
  dataOffset: number;
  /** Bytes per frame. */
  frameBytes: number;
  /** Samples per frame (pixelCount × 3). */
  frameSamples: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function durationMsOf(header: Pick<ShowHeader, "frameCount" | "fps">): number {
  return (header.frameCount / header.fps) * 1000;
}

/** The file's leading bytes: magic, length, JSON, padding. Frame data follows immediately. */
export function encodeShowHeader(header: ShowHeader): Uint8Array {
  const problems = validateHeader(header);
  if (problems.length) throw new Error(`invalid show header: ${problems.join("; ")}`);

  const json = encoder.encode(JSON.stringify(header));
  const unpadded = 12 + json.length;
  const padded = Math.ceil(unpadded / 8) * 8;
  const out = new Uint8Array(padded).fill(0x20); // pad with spaces: still valid JSON to a casual reader
  out.set(encoder.encode(SHOW_MAGIC), 0);
  new DataView(out.buffer).setUint32(8, padded - 12, true);
  out.set(json, 12);
  return out;
}

function validateHeader(h: ShowHeader): string[] {
  const problems: string[] = [];
  if (h.version !== SHOW_VERSION) problems.push(`version ${h.version} (this build reads ${SHOW_VERSION})`);
  if (!(h.fps > 0 && h.fps <= 1000)) problems.push(`fps ${h.fps}`);
  if (h.bits !== 8 && h.bits !== 16) problems.push(`bits ${h.bits} (8 or 16)`);
  if (!Number.isInteger(h.pixelCount) || h.pixelCount < 1) problems.push(`pixelCount ${h.pixelCount}`);
  if (!Number.isInteger(h.frameCount) || h.frameCount < 1) problems.push(`frameCount ${h.frameCount}`);
  if (!(h.transfer > 0)) problems.push(`transfer ${h.transfer}`);
  if (typeof h.experience !== "string" || !h.experience.trim()) problems.push("no experience name");
  if (!h.patch || !Array.isArray(h.patch.runs) || !Array.isArray(h.patch.gateways)) problems.push("no patch");
  else if (h.patch.pixelCount !== h.pixelCount) problems.push(`patch is for ${h.patch.pixelCount} pixels, frames are ${h.pixelCount}`);
  return problems;
}

/** How many leading bytes are needed to parse the header — read 12, call this, then read the rest. */
export function showHeaderSpan(first12: Uint8Array): number {
  if (first12.length < 12 || decoder.decode(first12.subarray(0, 8)) !== SHOW_MAGIC) {
    throw new Error("not a .show file (bad magic)");
  }
  return 12 + new DataView(first12.buffer, first12.byteOffset, 12).getUint32(8, true);
}

/**
 * Parse a show from its bytes. `bytes` need only cover the header; pass `fileSize` to also check
 * the file is as long as its header claims — a truncated copy must fail here, loudly, not as a
 * read past the end of a mapping halfway through a show.
 */
export function parseShow(bytes: Uint8Array, fileSize?: number): ParsedShow {
  const span = showHeaderSpan(bytes);
  if (bytes.length < span) throw new Error("show header is truncated");

  let header: ShowHeader;
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(12, span)));
  } catch {
    throw new Error("show header is not valid JSON");
  }
  const problems = validateHeader(header);
  if (problems.length) throw new Error(`bad show header: ${problems.join("; ")}`);

  const frameSamples = header.pixelCount * 3;
  const frameBytes = frameSamples * (header.bits / 8);
  const expected = span + frameBytes * header.frameCount;
  if (fileSize !== undefined && fileSize < expected) {
    throw new Error(`show is truncated: ${fileSize} bytes, header promises ${expected}`);
  }
  return { header, dataOffset: span, frameBytes, frameSamples };
}

/**
 * A zero-copy view of one frame. For 16-bit shows this is a Uint16Array over the same memory, which
 * is why the header is padded to 8 bytes — the view must start on an even offset.
 */
export function frameView(bytes: Uint8Array, show: ParsedShow, index: number): Uint8Array | Uint16Array {
  const start = show.dataOffset + index * show.frameBytes;
  if (show.header.bits === 16) {
    return new Uint16Array(bytes.buffer, bytes.byteOffset + start, show.frameSamples);
  }
  return bytes.subarray(start, start + show.frameBytes);
}

/** Encode a linear-light value (0–1) as a sample. The inverse of what the client's output does. */
export function encodeSample(linear: number, bits: SampleBits, transfer = SHOW_TRANSFER): number {
  const max = bits === 16 ? 65535 : 255;
  if (!(linear > 0)) return 0;
  if (linear >= 1) return max;
  return Math.round(Math.pow(linear, 1 / transfer) * max);
}

/** Filesystem slug for editor bake output. */
export function slugOf(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

