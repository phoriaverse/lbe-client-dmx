// The page's calls to its own Bun process. All file I/O goes through here.

import { parseRig, type RigDocument, serializeRig } from "../model/rig";
import { newSequence, parseSequence, type SequenceDocument, serializeSequence } from "../model/sequence";
import { remember, rigStore, seqStore } from "./state";

export let rigPath = "project/rig.json";
/** Set when the rig on disk could not be read: saving would replace it with whatever is on screen. */
let loadFailed = false;

export async function loadRig(): Promise<{ exists: boolean }> {
  const res = await fetch("/api/rig");
  const body = await res.json();
  if (body.path) rigPath = body.path;
  if (!res.ok) {
    loadFailed = true;
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  loadFailed = false;
  rigStore.load(parseRig(serializeRig(body.rig as RigDocument)));
  // A rig that doesn't exist on disk yet is unsaved work, even though it is untouched.
  if (!body.exists) rigStore.markSaved(-1);
  return { exists: body.exists };
}

export async function saveRig(): Promise<void> {
  if (loadFailed) throw new Error(`${rigPath} could not be read, so it will not be overwritten — fix or move it, then Reload`);
  const revision = rigStore.currentRevision;
  const res = await fetch("/api/rig", { method: "PUT", body: serializeRig(rigStore.get()) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  // Edits made while the save was in flight stay dirty.
  rigStore.markSaved(revision);
}

export async function listModels(): Promise<{ file: string; sizeBytes: number }[]> {
  const res = await fetch("/api/models");
  return (await res.json()).models;
}

export async function uploadModel(file: File): Promise<string> {
  const res = await fetch(`/api/models?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.file;
}

// ── Sequences ────────────────────────────────────────────────────────────────

/** A tiny observable value, for lists the page fetches (sequences on disk, media, bake state). */
export class Value<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = () => this.value;
  set(value: T) {
    this.value = value;
    for (const fn of this.listeners) fn();
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

/** The sequences saved on disk (the open one may be newer than its entry, or not there yet). */
export const sequenceList = new Value<SequenceDocument[]>([]);

async function fetchSequences(): Promise<SequenceDocument[]> {
  const body = await (await fetch("/api/sequences")).json();
  for (const p of body.problems ?? []) console.warn(`[sequences] ${p.file}: ${p.problem}`);
  sequenceList.set(body.sequences);
  return body.sequences;
}

const openDoc = (doc: SequenceDocument, onDisk: boolean) => {
  seqStore.load(parseSequence(serializeSequence(doc)));
  if (!onDisk) seqStore.markSaved(-1);
  remember("sequence", doc.id);
};

/** Open the sequence that was open last time, else the first on disk, else a new unsaved one. */
export async function loadSequences(): Promise<void> {
  const all = await fetchSequences();
  let last: string | null = null;
  try {
    last = localStorage.getItem("lighting-editor.sequence");
  } catch {}
  const pick = all.find((s) => s.id === last) ?? all[0];
  if (pick) openDoc(pick, true);
  else openDoc(newSequence(), false);
}

export async function openSequence(id: string): Promise<void> {
  const doc = (await fetchSequences()).find((s) => s.id === id);
  if (!doc) throw new Error(`no sequence "${id}" on disk`);
  openDoc(doc, true);
}

/** A new, unsaved sequence with a free id derived from its name. */
export function createSequence(name: string) {
  const taken = new Set(sequenceList.get().map((s) => s.id));
  const stem = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "sequence";
  let id = stem;
  for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
  openDoc(newSequence(id, name), false);
}

export async function saveSequence(): Promise<void> {
  const revision = seqStore.currentRevision;
  const seq = seqStore.get();
  const res = await fetch(`/api/sequences/${seq.id}`, { method: "PUT", body: serializeSequence(seq) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  seqStore.markSaved(revision);
  await fetchSequences();
}

export async function deleteSequence(id: string): Promise<void> {
  const res = await fetch(`/api/sequences/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rest = await fetchSequences();
  if (seqStore.get().id === id) {
    if (rest[0]) openDoc(rest[0], true);
    else openDoc(newSequence(), false);
  }
}

/** Save whatever is unsaved: the rig and the open sequence. */
export async function saveAll(): Promise<string[]> {
  const saved: string[] = [];
  if (rigStore.dirty) {
    await saveRig();
    saved.push(rigPath);
  }
  if (seqStore.dirty) {
    await saveSequence();
    saved.push(`sequence "${seqStore.get().name}"`);
  }
  return saved;
}

// ── Media ────────────────────────────────────────────────────────────────────

export interface MediaVideo {
  name: string;
  sizeBytes: number;
  /** Directory it was found in, relative to the repo. */
  source: string;
  url: string;
}

export const mediaList = new Value<{ videos: MediaVideo[]; ffmpeg: boolean }>({ videos: [], ffmpeg: true });

export async function loadMedia(): Promise<void> {
  mediaList.set(await (await fetch("/api/media")).json());
}

// ── Bake ─────────────────────────────────────────────────────────────────────

export interface BakeStatus {
  state: "idle" | "running" | "done" | "error";
  id?: string;
  done?: number;
  total?: number;
  error?: string;
  result?: { relative: string; experience: string; frameCount: number; durationMs: number; fps: number; bits: number; pixelCount: number; sizeBytes: number; tookMs: number; warnings: string[] };
  ffmpeg: boolean;
  showsDir: string;
}

export const bakeStatus = new Value<BakeStatus>({ state: "idle", ffmpeg: true, showsDir: "dmx-client/shows" });

export async function refreshBake(): Promise<BakeStatus> {
  const status = (await (await fetch("/api/bake")).json()) as BakeStatus;
  bakeStatus.set(status);
  return status;
}

/** Save, then bake the open sequence. Resolves when the bake has finished, either way. */
export async function bakeSequence(): Promise<BakeStatus> {
  await saveAll();
  if (rigStore.dirty || seqStore.dirty) throw new Error("could not save before baking");
  const res = await fetch("/api/bake", { method: "POST", body: JSON.stringify({ id: seqStore.get().id }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  for (;;) {
    const status = await refreshBake();
    if (status.state !== "running") return status;
    await new Promise((r) => setTimeout(r, 250));
  }
}
