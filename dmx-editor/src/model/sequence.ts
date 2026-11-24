// A sequence: what plays on the rig for one experience.
//
// There is ONE rig and many sequences. A sequence nominates the experience it answers to (the
// name the control server sends, i.e. a key of bun-server/src/experiences.ts), chooses which video
// plays on each of the rig's video surfaces, and carries the bake settings. It never redefines
// anything physical — surfaces and lights are referred to by their rig node id.
//
// Milestone 3 is deliberately the minimum a bake needs. The timeline, layers and keyframes of
// milestone 4 grow out of this document; the version number is how that will be told apart.
//
// One file per sequence: project/sequences/<id>.json, same plain-JSON rules as the rig.

import type { SampleBits } from "../../../dmx-client/src/shared/show-file";
import { isSurface, type RigDocument } from "./rig";

export const SEQUENCE_FORMAT = "lbe-sequence";
export const SEQUENCE_VERSION = 1;

/** How lights take colour from surfaces. */
export type Sampling =
  /** Every surface whose projection covers a pixel adds its colour. Uncovered pixels stay dark. */
  | "projection"
  /** Every pixel takes the closest point of whichever surface is nearest to it. Nothing is dark. */
  | "nearest"
  /** A recorded colour/intensity track drives every pixel together, independent of position. */
  | "unison";

export interface UnisonLighting {
  /** Playback video whose zero is also the start of this track. */
  video: string;
  /** Original source and trim position, retained for preparing a waiting loop later. */
  source: string;
  sourceStartMs: number;
  /** Fixed colour in sRGB bytes; intensity samples below are linear light. */
  color: [number, number, number];
  fps: number;
  intensities: number[];
  description: string;
}

export interface SurfaceUse {
  /** Bare file name, resolved in dmx-editor/media/ then the repo-root media/. null = nothing. */
  video: string | null;
  /** Linear-light multiplier for this surface alone. */
  gain: number;
}

export interface SequenceDocument {
  format: typeof SEQUENCE_FORMAT;
  version: typeof SEQUENCE_VERSION;
  /** File stem under project/sequences/. Letters, digits, dashes. */
  id: string;
  name: string;
  /** The experience this bakes for — must match what the console sends. "ambient" is the idle loop. */
  experience: string;
  /** Bake settings; recorded in the .show header. */
  fps: number;
  bits: SampleBits;
  /** Length in ms, or null to follow the longest video in use. */
  durationMs: number | null;
  /**
   * Overall level in linear light, baked in. It sits UNDER the client's master and cap, so the wall
   * sees level × master × cap. Default 0.35, the same modest peak make-test-show uses: the
   * full-brightness test of a 21-tube chain is still open.
   */
  level: number;
  sampling: Sampling;
  /** Long edge, in pixels, that videos are scaled to before sampling. The scale-down is the blur. */
  sampleSize: number;
  /** Per surface node id. A surface with no entry plays nothing. */
  surfaces: Record<string, SurfaceUse>;
  /** Optional analysed/authored track, evaluated by the same clock in preview and bake. */
  unison?: UnisonLighting;
}

export const DEFAULT_LEVEL = 0.35;

export function newSequence(id = "sequence-1", name = "Sequence 1"): SequenceDocument {
  return {
    format: SEQUENCE_FORMAT,
    version: SEQUENCE_VERSION,
    id,
    name,
    experience: name,
    fps: 40,
    bits: 8,
    durationMs: null,
    level: DEFAULT_LEVEL,
    sampling: "projection",
    sampleSize: 256,
    surfaces: {},
  };
}

export const serializeSequence = (seq: SequenceDocument) => `${JSON.stringify(seq, null, 2)}\n`;

export const SEQUENCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function sequenceFileProblems(raw: unknown): string[] {
  const p: string[] = [];
  if (!isObj(raw)) return ["not an object"];
  if (raw.format !== SEQUENCE_FORMAT) p.push(`format is ${JSON.stringify(raw.format)}, expected "${SEQUENCE_FORMAT}"`);
  if (raw.version !== SEQUENCE_VERSION) p.push(`version ${JSON.stringify(raw.version)} (this editor reads ${SEQUENCE_VERSION})`);
  if (typeof raw.id !== "string" || !SEQUENCE_ID.test(raw.id)) p.push(`id ${JSON.stringify(raw.id)} is not lowercase letters, digits and dashes`);
  if (typeof raw.name !== "string") p.push("name is missing");
  if (typeof raw.experience !== "string") p.push("experience is missing");
  if (!isNum(raw.fps) || raw.fps <= 0 || raw.fps > 1000) p.push(`fps is ${raw.fps}`);
  if (raw.bits !== 8 && raw.bits !== 16) p.push(`bits is ${raw.bits} (8 or 16)`);
  if (raw.durationMs !== null && !(isNum(raw.durationMs) && raw.durationMs > 0)) p.push(`durationMs is ${raw.durationMs}`);
  if (!isNum(raw.level) || raw.level < 0) p.push(`level is ${raw.level}`);
  if (raw.sampling !== "projection" && raw.sampling !== "nearest" && raw.sampling !== "unison") p.push(`sampling is ${JSON.stringify(raw.sampling)}`);
  if (raw.unison !== undefined) {
    const u = raw.unison;
    if (!isObj(u)) p.push("unison track is malformed");
    else {
      if (typeof u.video !== "string" || !u.video.trim() || typeof u.source !== "string" || typeof u.description !== "string") p.push("unison source is missing");
      if (!isNum(u.sourceStartMs) || u.sourceStartMs < 0) p.push("unison source start must be non-negative");
      if (!isNum(u.fps) || u.fps <= 0 || u.fps > 1000) p.push("unison fps is invalid");
      if (!Array.isArray(u.color) || u.color.length !== 3 || u.color.some((v) => !isNum(v) || v < 0 || v > 255 || !Number.isInteger(v))) p.push("unison colour must be three sRGB bytes");
      if (!Array.isArray(u.intensities) || !u.intensities.length || u.intensities.some((v) => !isNum(v) || v < 0 || v > 1)) p.push("unison intensities must be samples between 0 and 1");
    }
  }
  if (raw.sampling === "unison" && raw.unison === undefined) p.push("unison sampling needs a lighting track");
  if (!Number.isInteger(raw.sampleSize) || (raw.sampleSize as number) < 2 || (raw.sampleSize as number) > 4096) p.push(`sampleSize is ${raw.sampleSize}`);
  if (!isObj(raw.surfaces)) p.push("surfaces is missing");
  else
    for (const [id, use] of Object.entries(raw.surfaces)) {
      if (!isObj(use) || (use.video !== null && typeof use.video !== "string") || !isNum(use.gain) || use.gain < 0) p.push(`surface "${id}" is malformed`);
    }
  if (raw.sampling === "unison" && isObj(raw.unison) && isObj(raw.surfaces) && !Object.values(raw.surfaces).some((use) => isObj(use) && use.video === (raw.unison as Record<string, unknown>).video)) p.push("unison video must be assigned to a screen");
  return p;
}

export function parseSequence(text: string): SequenceDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`sequence is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  const problems = sequenceFileProblems(raw);
  if (problems.length) throw new Error(`sequence file is invalid: ${problems.join("; ")}`);
  return raw as SequenceDocument;
}

// ── Edits (run inside DocStore.edit) ─────────────────────────────────────────

export function setSurfaceUse(seq: SequenceDocument, surfaceId: string, patch: Partial<SurfaceUse>) {
  seq.surfaces[surfaceId] = { video: null, gain: 1, ...seq.surfaces[surfaceId], ...patch };
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** The surfaces of the rig that this sequence plays a video on, in hierarchy order. */
export function activeSurfaces(rig: RigDocument, seq: SequenceDocument) {
  return rig.nodes.filter(isSurface).flatMap((node) => {
    const use = seq.surfaces[node.id];
    return use?.video ? [{ node, video: use.video, gain: use.gain }] : [];
  });
}

/** The distinct videos in use, in first-use order. */
export function videosInUse(rig: RigDocument, seq: SequenceDocument): string[] {
  return [...new Set(activeSurfaces(rig, seq).map((s) => s.video))];
}

/**
 * How long the sequence runs: its override, else the longest video in use, else 0 (unknown —
 * nothing to follow). `videoDurationMs` answers what it can; an unknown video counts as 0.
 */
export function sequenceDurationMs(rig: RigDocument, seq: SequenceDocument, videoDurationMs: (video: string) => number | undefined): number {
  if (seq.durationMs !== null) return seq.durationMs;
  return videosInUse(rig, seq).reduce((max, v) => Math.max(max, videoDurationMs(v) ?? 0), 0);
}

export const frameCountOf = (durationMs: number, fps: number) => Math.max(0, Math.round((durationMs / 1000) * fps));

/**
 * The size a video is scaled to before sampling: its long edge becomes `sampleSize`, the aspect is
 * kept, both sides even (ffmpeg's yuv scaling wants that) and never larger than the source. The
 * browser preview and the bake both use this, so they sample the same grid.
 */
export function sampleDims(width: number, height: number, sampleSize: number): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const k = Math.min(1, sampleSize / Math.max(width, height));
  return { width: even(width * k), height: even(height * k) };
}
