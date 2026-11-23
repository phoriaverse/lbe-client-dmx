// Where sampling videos live, and decoding them with ffmpeg. Bun-side only.
//
// Two directories are searched, in order: dmx-editor/media/ (videos made only for lighting)
// and the repo-root media/ (the show's own videos — the ones the screens play). Reading the second
// means a show video is never copied just to be sampled. A name in both resolves to the editor's.

import fs from "node:fs";
import path from "node:path";
import type { Picture } from "../model/evaluate";

const EDITOR_ROOT = path.resolve(import.meta.dir, "../..");
export const MEDIA_DIRS = [path.join(EDITOR_ROOT, "media"), path.resolve(EDITOR_ROOT, "../media")];
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i;

export interface MediaEntry {
  name: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  /** Which directory it came from, relative to the repo, for the UI. */
  source: string;
}

export function listMedia(dirs = MEDIA_DIRS): MediaEntry[] {
  const seen = new Map<string, MediaEntry>();
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && VIDEO_EXT.test(e.name)).map((e) => e.name);
    } catch {
      continue; // a missing directory is just an empty one
    }
    for (const name of names.sort()) {
      if (seen.has(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      seen.set(name, { name, path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs, source: path.relative(path.resolve(EDITOR_ROOT, ".."), dir) });
    }
  }
  return [...seen.values()];
}

/** A bare file name → its path, or null. Names with a directory in them never resolve. */
export function resolveMedia(name: string, dirs = MEDIA_DIRS): string | null {
  if (!name || name !== path.basename(name) || !VIDEO_EXT.test(name)) return null;
  for (const dir of dirs) {
    const full = path.join(dir, name);
    if (fs.statSync(full, { throwIfNoEntry: false })?.isFile()) return full;
  }
  return null;
}

// ── ffmpeg ───────────────────────────────────────────────────────────────────

/** Homebrew's bin is not always on the PATH of whatever launched the editor, so look there too. */
export function findTool(name: "ffmpeg" | "ffprobe"): string | null {
  const onPath = Bun.which(name);
  if (onPath) return onPath;
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export const FFMPEG_MISSING = "ffmpeg is not installed. Run `brew install ffmpeg`, then bake again.";

export interface VideoInfo {
  width: number;
  height: number;
  durationMs: number;
  fps: number;
}

export async function probeVideo(file: string): Promise<VideoInfo> {
  const ffprobe = findTool("ffprobe");
  if (!ffprobe) throw new Error(FFMPEG_MISSING);
  const proc = Bun.spawn([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,duration:format=duration", "-of", "json", file], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`ffprobe could not read ${path.basename(file)}: ${err.trim() || `exit ${code}`}`);
  const info = JSON.parse(out) as { streams?: { width?: number; height?: number; r_frame_rate?: string; duration?: string }[]; format?: { duration?: string } };
  const stream = info.streams?.[0];
  if (!stream?.width || !stream.height) throw new Error(`${path.basename(file)} has no video stream`);
  const [num, den] = (stream.r_frame_rate ?? "0/1").split("/").map(Number);
  // The picture's own length, not the container's: audio often runs longer, and the lights follow the picture.
  const seconds = Number(stream.duration) || Number(info.format?.duration) || 0;
  return { width: stream.width, height: stream.height, durationMs: seconds * 1000, fps: den ? num! / den : 0 };
}

/** Pictures of one video, in order, one per output frame. */
export interface Decoder {
  /** The next picture, or null once the video has ended. The returned buffer is reused by the next call. */
  next(): Promise<Picture | null>;
  close(): void;
}

/**
 * Decode `file` as `fps` pictures a second at exactly width × height, RGB. ffmpeg's `fps` filter
 * does the retiming (it picks the source frame nearest each output instant), and `scale` with area
 * averaging does the scale-down — which is also the blur that stops a sparse row of pixels from
 * aliasing against fine picture detail.
 */
export function ffmpegDecoder(file: string, opts: { fps: number; width: number; height: number }): Decoder {
  const ffmpeg = findTool("ffmpeg");
  if (!ffmpeg) throw new Error(FFMPEG_MISSING);
  const proc = Bun.spawn(
    [ffmpeg, "-v", "error", "-nostdin", "-i", file, "-an", "-sn", "-vf", `fps=${opts.fps},scale=${opts.width}:${opts.height}:flags=area`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const stderr = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const frameBytes = opts.width * opts.height * 3;
  const frame = new Uint8Array(frameBytes);
  let pending: Uint8Array | null = null; // bytes read past the end of the last frame
  let ended = false;

  return {
    async next() {
      if (ended) return null;
      let filled = 0;
      while (filled < frameBytes) {
        let chunk: Uint8Array | null = pending;
        pending = null;
        if (!chunk) {
          const { value, done } = await reader.read();
          if (done) {
            ended = true;
            const code = await proc.exited;
            if (code !== 0) throw new Error(`ffmpeg failed on ${path.basename(file)}: ${(await stderr).trim() || `exit ${code}`}`);
            return null; // a trailing partial frame is dropped
          }
          chunk = value;
        }
        const take = Math.min(chunk.length, frameBytes - filled);
        frame.set(chunk.subarray(0, take), filled);
        filled += take;
        if (take < chunk.length) pending = chunk.subarray(take);
      }
      return { width: opts.width, height: opts.height, stride: 3, data: frame };
    },
    close() {
      ended = true;
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
