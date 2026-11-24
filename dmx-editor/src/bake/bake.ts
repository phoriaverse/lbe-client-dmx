// The bake: rig + sequence → a .show file lighting-client plays.
//
// For every output frame it asks each video's decoder for the picture at that instant, hands the
// pictures to THE evaluator (model/evaluate.ts — the same one the browser preview runs), encodes
// the result the way the .show format says, and appends it. The file is written beside its final
// name and renamed over it, so a client that is scanning shows/ — or playing the previous bake —
// never sees half a file.
//
// Decoding is injected (`probe`, `decoder`) so the tests can bake from synthetic pictures without
// ffmpeg; the defaults are the ffmpeg ones in media.ts.

import fs from "node:fs";
import path from "node:path";
import { type ShowHeader, SHOW_EXTENSION, SHOW_TRANSFER, SHOW_VERSION, encodeShowHeader, slugOf } from "../../../dmx-client/src/shared/show-file";
import { buildPlan, evaluateFrame, type Picture } from "../model/evaluate";
import { compileRigPatch, rigProblems } from "../model/patch";
import { encodeFrame } from "../model/pixels";
import { type RigDocument, serializeRig } from "../model/rig";
import { frameCountOf, sampleDims, type SequenceDocument, serializeSequence, videosInUse } from "../model/sequence";
import { type Decoder, ffmpegDecoder, probeVideo, resolveMedia, type VideoInfo } from "./media";

export const DEFAULT_SHOWS_DIR = path.resolve(import.meta.dir, "../../../dmx-client/shows");

export interface BakeOptions {
  rig: RigDocument;
  sequence: SequenceDocument;
  showsDir?: string;
  /** Called with frames done / total, at most a few times a second. */
  onProgress?: (done: number, total: number) => void;
  /** Video name → path. Default: dmx-editor/media/, then the repo-root media/. */
  resolve?: (video: string) => string | null;
  probe?: (file: string) => Promise<VideoInfo>;
  decoder?: (file: string, opts: { fps: number; width: number; height: number }) => Decoder;
}

export interface BakeResult {
  file: string;
  experience: string;
  frameCount: number;
  durationMs: number;
  fps: number;
  bits: number;
  pixelCount: number;
  sizeBytes: number;
  tookMs: number;
  /** Things that did not stop the bake but that someone should read. */
  warnings: string[];
}

export async function bake(opts: BakeOptions): Promise<BakeResult> {
  const { rig, sequence: seq } = opts;
  const started = performance.now();
  const resolve = opts.resolve ?? resolveMedia;
  const probe = opts.probe ?? probeVideo;
  const makeDecoder = opts.decoder ?? ffmpegDecoder;
  const showsDir = opts.showsDir ?? DEFAULT_SHOWS_DIR;
  const warnings: string[] = [];

  if (!seq.experience.trim()) throw new Error("the sequence names no experience");
  // The client refuses a show whose patch is invalid, so there is no point writing one.
  const problems = rigProblems(rig);
  if (problems.length) throw new Error(`the rig has problems (see the Patch tab): ${problems[0]}`);
  const patch = compileRigPatch(rig);
  if (patch.pixelCount < 1) throw new Error("the rig has no lights");
  if (!patch.runs.length) warnings.push("no light is on a chain, so this show would light nothing");

  // ── The videos ─────────────────────────────────────────────────────────────
  const videos = videosInUse(rig, seq);
  if (!videos.length) warnings.push("no surface has a video, so this show is dark");
  const infos = new Map<string, VideoInfo & { file: string }>();
  for (const video of videos) {
    const file = resolve(video);
    if (!file) throw new Error(`${video} is not in dmx-editor/media/ or the repo's media/`);
    infos.set(video, { ...(await probe(file)), file });
  }

  const longest = Math.max(0, ...[...infos.values()].map((i) => i.durationMs));
  const durationMs = seq.durationMs ?? longest;
  if (!(durationMs > 0)) throw new Error("the sequence has no length: give a surface a video, or set the length");
  const frameCount = frameCountOf(durationMs, seq.fps);
  if (frameCount < 1) throw new Error("the sequence is shorter than one frame");
  for (const [video, info] of infos) {
    if (info.durationMs + 1000 / seq.fps < durationMs) warnings.push(`${video} ends at ${(info.durationMs / 1000).toFixed(2)}s; its surfaces are dark after that`);
  }

  // ── The file ───────────────────────────────────────────────────────────────
  const plan = buildPlan(rig, seq);
  const lit = new Set(plan.surfaces.flatMap((s) => [...s.pixels])).size;
  if (videos.length && lit === 0) warnings.push("no pixel is inside any surface's projection, so this show is dark");

  const header: ShowHeader = {
    version: SHOW_VERSION,
    name: seq.name,
    experience: seq.experience,
    fps: seq.fps,
    bits: seq.bits,
    pixelCount: patch.pixelCount,
    frameCount,
    transfer: SHOW_TRANSFER,
    patch,
    bakedAt: new Date().toISOString(),
    bakedBy: "lighting-editor",
    hashes: { rig: hashOf(serializeRig(rig)), sequence: hashOf(serializeSequence(seq)) },
  };

  fs.mkdirSync(showsDir, { recursive: true });
  // One file per experience: a re-bake replaces the last one instead of leaving two shows that
  // both answer to the same name.
  const file = path.join(showsDir, `${slugOf(seq.experience)}${SHOW_EXTENSION}`);
  const tmp = `${file}.${process.pid}.tmp`;

  const decoders = new Map<string, Decoder>();
  const pictures = new Map<string, Picture | null>();
  const fd = fs.openSync(tmp, "w");
  try {
    for (const [video, info] of infos) decoders.set(video, makeDecoder(info.file, { fps: seq.fps, ...sampleDims(info.width, info.height, seq.sampleSize) }));

    fs.writeSync(fd, encodeShowHeader(header));
    const frame = new Float32Array(patch.pixelCount * 3);
    let lastReport = 0;
    for (let f = 0; f < frameCount; f++) {
      for (const [video, decoder] of decoders) pictures.set(video, await decoder.next());
      evaluateFrame(plan, (video) => pictures.get(video) ?? null, frame, f * 1000 / seq.fps);
      fs.writeSync(fd, encodeFrame(frame, seq.bits));
      const now = performance.now();
      if (opts.onProgress && (now - lastReport > 200 || f === frameCount - 1)) {
        lastReport = now;
        opts.onProgress(f + 1, frameCount);
      }
    }
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    for (const d of decoders.values()) d.close();
  }

  return {
    file,
    experience: seq.experience,
    frameCount,
    durationMs: (frameCount / seq.fps) * 1000,
    fps: seq.fps,
    bits: seq.bits,
    pixelCount: patch.pixelCount,
    sizeBytes: fs.statSync(file).size,
    tookMs: performance.now() - started,
    warnings,
  };
}

const hashOf = (text: string) => Bun.hash(text).toString(16);
