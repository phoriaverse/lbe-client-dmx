// lighting-editor's Bun process: serves the editor page and owns its files.
//
// It is deliberately thin. The editor is a browser app; this process exists for the things a page
// cannot do — read and write the rig file atomically, accept a room model upload onto disk, and
// (milestone 3) decode video with ffmpeg and bake .show files.
//
// It never sends Art-Net and never talks to the gateway. Live preview goes from the PAGE straight
// to a running lighting-client's /preview WebSocket — the client is the only Art-Net sender.
//
//   GET  /                     the editor (bundled from src/web by Bun's HTML import)
//   GET  /api/rig              the rig file, or a new rig if there is none yet
//   PUT  /api/rig              save: validated, written to a temp file, renamed over the rig
//   GET  /api/models           room models available in models/
//   POST /api/models?name=     upload a room model into models/
//   GET  /models/<file>        a room model
//   GET  /draco/<file>         three.js's Draco decoder, for compressed GLBs
//   GET  /api/sequences        every sequence in project/sequences/
//   PUT  /api/sequences/<id>   save one (same temp-then-rename as the rig)
//   DELETE /api/sequences/<id>
//   GET  /api/media            sampling videos: dmx-editor/media/ then the repo-root media/
//   GET  /media/<file>         a sampling video, with HTTP Range (a <video> cannot seek without it)
//   POST /api/bake {id}        bake a SAVED sequence to dmx-client/shows/ (needs ffmpeg)
//   GET  /api/bake             how that is going

import fs from "node:fs";
import path from "node:path";
import editorPage from "../web/index.html";
import { bake, type BakeResult, DEFAULT_SHOWS_DIR } from "../bake/bake";
import { findTool, listMedia, resolveMedia } from "../bake/media";
import { newRig, parseRig, serializeRig } from "../model/rig";
import { parseSequence, SEQUENCE_ID, type SequenceDocument, serializeSequence } from "../model/sequence";

const ROOT = path.resolve(import.meta.dir, "../..");
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const PORT = Number(flag("port") ?? process.env.LBE_EDITOR_PORT ?? 8092);
const HOST = flag("host") ?? process.env.LBE_EDITOR_HOST ?? "127.0.0.1";
const RIG_PATH = path.resolve(ROOT, flag("rig") ?? process.env.LBE_EDITOR_RIG ?? "project/rig.json");
const SEQUENCES_DIR = path.join(path.dirname(RIG_PATH), "sequences");
const SHOWS_DIR = flag("shows") ? path.resolve(flag("shows")!) : process.env.LBE_EDITOR_SHOWS ? path.resolve(process.env.LBE_EDITOR_SHOWS) : DEFAULT_SHOWS_DIR;
const MODELS_DIR = path.join(ROOT, "models");
const DRACO_DIR = path.join(ROOT, "node_modules/three/examples/jsm/libs/draco/gltf");
const MODEL_EXT = /\.(glb|gltf)$/i;

fs.mkdirSync(path.dirname(RIG_PATH), { recursive: true });
fs.mkdirSync(MODELS_DIR, { recursive: true });

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Write next to the target and rename over it: a crash mid-save leaves the old rig, never half a new one. */
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** A file name safe to put in models/: no directories, no dot-files, model extensions only. */
function safeModelName(name: string | null): string | null {
  if (!name) return null;
  const base = path.basename(name).replace(/[^\w.\- ]+/g, "_").trim();
  return base && !base.startsWith(".") && MODEL_EXT.test(base) ? base : null;
}

function listModels() {
  return fs
    .readdirSync(MODELS_DIR)
    .filter((f) => MODEL_EXT.test(f))
    .map((f) => ({ file: `models/${f}`, sizeBytes: fs.statSync(path.join(MODELS_DIR, f)).size }));
}

// ── Sequences ────────────────────────────────────────────────────────────────

const sequencePath = (id: string) => path.join(SEQUENCES_DIR, `${id}.json`);

function listSequences(): { sequences: SequenceDocument[]; problems: { file: string; problem: string }[] } {
  const sequences: SequenceDocument[] = [];
  const problems: { file: string; problem: string }[] = [];
  if (!fs.existsSync(SEQUENCES_DIR)) return { sequences, problems };
  for (const file of fs.readdirSync(SEQUENCES_DIR).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const seq = parseSequence(fs.readFileSync(path.join(SEQUENCES_DIR, file), "utf8"));
      if (`${seq.id}.json` !== file) throw new Error(`its id is "${seq.id}" but the file is ${file}`);
      sequences.push(seq);
    } catch (err) {
      problems.push({ file, problem: err instanceof Error ? err.message : String(err) });
    }
  }
  return { sequences, problems };
}

// ── Media: one <video>-seekable file response ────────────────────────────────

/**
 * A file with HTTP Range. `new Response(Bun.file(path))` ignores the Range header and answers 200
 * with the whole body, and a <video> cannot seek without 206s (the same finding as video-client's
 * media.ts, which this follows).
 */
function rangedFile(file: string, req: Request): Response {
  const size = fs.statSync(file).size;
  const headers: Record<string, string> = { "accept-ranges": "bytes", "content-type": Bun.file(file).type, "cache-control": "no-cache" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range")?.trim() ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return new Response(Bun.file(file), { headers: { ...headers, "content-length": String(size) } });
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  return new Response(Bun.file(file).slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
  });
}

// ── Bake: one at a time, polled by the page ──────────────────────────────────

type BakeState =
  | { state: "idle" }
  | { state: "running"; id: string; done: number; total: number }
  | { state: "done"; id: string; result: BakeResult & { relative: string } }
  | { state: "error"; id: string; error: string };
let bakeState: BakeState = { state: "idle" };

function startBake(id: string): string | null {
  if (bakeState.state === "running") return "a bake is already running";
  let rig, sequence;
  try {
    rig = parseRig(fs.readFileSync(RIG_PATH, "utf8"));
    sequence = parseSequence(fs.readFileSync(sequencePath(id), "utf8"));
  } catch (err) {
    return `could not read the saved rig or sequence: ${err instanceof Error ? err.message : err}`;
  }
  bakeState = { state: "running", id, done: 0, total: 0 };
  bake({ rig, sequence, showsDir: SHOWS_DIR, onProgress: (done, total) => (bakeState = { state: "running", id, done, total }) }).then(
    (result) => {
      bakeState = { state: "done", id, result: { ...result, relative: path.relative(path.resolve(ROOT, ".."), result.file) } };
      console.log(`[bake] ${result.experience} → ${result.file} (${result.frameCount} frames, ${(result.tookMs / 1000).toFixed(1)}s)`);
    },
    (err) => {
      bakeState = { state: "error", id, error: err instanceof Error ? err.message : String(err) };
      console.warn(`[bake] ${id} failed: ${bakeState.error}`);
    },
  );
  return null;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // No HMR: a hot reload re-runs the page's modules and re-loads the rig from disk, silently
  // discarding unsaved edits (seen on 2026-11-16). Editing the editor is edit-then-refresh, and the
  // refresh is guarded by the unsaved-changes prompt.
  development: process.env.NODE_ENV === "production" ? false : { hmr: false },
  routes: {
    "/": editorPage,

    "/api/rig": {
      GET: () => {
        if (!fs.existsSync(RIG_PATH)) return json({ rig: newRig(), exists: false, path: path.relative(ROOT, RIG_PATH) });
        const text = fs.readFileSync(RIG_PATH, "utf8");
        try {
          return json({ rig: parseRig(text), exists: true, path: path.relative(ROOT, RIG_PATH) });
        } catch (err) {
          // Never hand the page a fresh rig in place of a broken one — saving that would overwrite it.
          return json({ error: err instanceof Error ? err.message : String(err), path: path.relative(ROOT, RIG_PATH) }, 422);
        }
      },
      PUT: async (req) => {
        const text = await req.text();
        try {
          const rig = parseRig(text);
          writeAtomic(RIG_PATH, serializeRig(rig));
          return json({ ok: true, path: path.relative(ROOT, RIG_PATH), savedAt: new Date().toISOString() });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      },
    },

    "/api/sequences": { GET: () => json(listSequences()) },

    "/api/sequences/:id": {
      PUT: async (req) => {
        try {
          const seq = parseSequence(await req.text());
          if (seq.id !== req.params.id) throw new Error(`the sequence's id is "${seq.id}", not "${req.params.id}"`);
          fs.mkdirSync(SEQUENCES_DIR, { recursive: true });
          writeAtomic(sequencePath(seq.id), serializeSequence(seq));
          return json({ ok: true, path: path.relative(ROOT, sequencePath(seq.id)) });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      },
      DELETE: (req) => {
        if (!SEQUENCE_ID.test(req.params.id)) return json({ error: "bad sequence id" }, 400);
        fs.rmSync(sequencePath(req.params.id), { force: true });
        return json({ ok: true });
      },
    },

    "/api/media": {
      GET: () => json({ videos: listMedia().map(({ name, sizeBytes, mtimeMs, source }) => ({ name, sizeBytes, source, url: `/media/${encodeURIComponent(name)}?v=${sizeBytes}-${Math.round(mtimeMs)}` })), ffmpeg: !!findTool("ffmpeg") && !!findTool("ffprobe") }),
    },

    "/api/bake": {
      GET: () => json({ ...bakeState, ffmpeg: !!findTool("ffmpeg") && !!findTool("ffprobe"), showsDir: path.relative(path.resolve(ROOT, ".."), SHOWS_DIR) }),
      POST: async (req) => {
        const body = (await req.json().catch(() => ({}))) as { id?: unknown };
        if (typeof body.id !== "string" || !SEQUENCE_ID.test(body.id)) return json({ error: "which sequence?" }, 400);
        const problem = startBake(body.id);
        return problem ? json({ error: problem }, 409) : json({ ok: true });
      },
    },

    "/api/models": {
      GET: () => json({ models: listModels() }),
      POST: async (req) => {
        const name = safeModelName(new URL(req.url).searchParams.get("name"));
        if (!name) return json({ error: "a .glb or .gltf file name is required" }, 400);
        const target = path.join(MODELS_DIR, name);
        const tmp = `${target}.${process.pid}.tmp`;
        await Bun.write(tmp, await req.arrayBuffer());
        fs.renameSync(tmp, target);
        console.log(`[models] saved ${name} (${(fs.statSync(target).size / 1e6).toFixed(1)} MB)`);
        return json({ file: `models/${name}` });
      },
    },
  },

  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.startsWith("/models/")) {
      const name = safeModelName(decodeURIComponent(url.pathname.slice("/models/".length)));
      const file = name && path.join(MODELS_DIR, name);
      if (file && fs.existsSync(file)) return new Response(Bun.file(file));
    }
    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      let name = "";
      try {
        name = decodeURIComponent(url.pathname.slice("/media/".length));
      } catch {
        /* malformed percent-encoding: falls through to 404 */
      }
      const file = resolveMedia(name);
      if (file) return rangedFile(file, req);
    }
    if (req.method === "GET" && url.pathname.startsWith("/draco/")) {
      const name = path.basename(url.pathname);
      const file = path.join(DRACO_DIR, name);
      if (fs.existsSync(file)) return new Response(Bun.file(file), { headers: { "cache-control": "max-age=86400" } });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`lighting-editor on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${server.port}`);
console.log(`  rig:    ${path.relative(process.cwd(), RIG_PATH)}${fs.existsSync(RIG_PATH) ? "" : " (new — created on first save)"}`);
console.log(`  models: ${path.relative(process.cwd(), MODELS_DIR)}/`);
console.log(`  bakes:  ${path.relative(process.cwd(), SHOWS_DIR)}/${findTool("ffmpeg") ? "" : "  (ffmpeg is not installed — `brew install ffmpeg` before baking)"}`);
