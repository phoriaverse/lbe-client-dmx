// Page-wide state: the ONE document store for the rig, one for the open sequence, and a small store
// for UI state that is not part of a document (selection, gizmo mode, which tab is open). Only the
// documents are saved; UI state is the viewer's own, a few conveniences of which persist in
// localStorage.

import { useSyncExternalStore } from "react";
import { newRig, type RigDocument } from "../model/rig";
import { newSequence, type SequenceDocument } from "../model/sequence";
import { DocStore } from "../model/store";

export const rigStore = new DocStore<RigDocument>(newRig());

export function useRig(): RigDocument {
  return useSyncExternalStore(rigStore.subscribe, rigStore.get);
}

export function useRigDirty(): boolean {
  return useSyncExternalStore(rigStore.subscribe, () => rigStore.dirty);
}

/** Run an edit; surfaces a refused edit (e.g. "lights cannot have children") as a notice. */
export function edit(label: string, recipe: (d: RigDocument) => void, coalesce?: string) {
  let problem: string | null = null;
  const ok = rigStore.edit(
    label,
    (d) => {
      try {
        recipe(d);
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
        throw err;
      }
    },
    { coalesce },
  );
  if (!ok && problem) notify(`${label}: ${problem}`, "error");
  return ok;
}

// ── The open sequence ────────────────────────────────────────────────────────

export const seqStore = new DocStore<SequenceDocument>(newSequence());

export function useSeq(): SequenceDocument {
  return useSyncExternalStore(seqStore.subscribe, seqStore.get);
}

export function useSeqDirty(): boolean {
  return useSyncExternalStore(seqStore.subscribe, () => seqStore.dirty);
}

/** Run an edit on the open sequence — the sequence's counterpart of `edit`. */
export function editSeq(label: string, recipe: (d: SequenceDocument) => void, coalesce?: string) {
  return seqStore.edit(label, recipe, { coalesce });
}

// ── UI state ─────────────────────────────────────────────────────────────────

export interface UiState {
  /** Selected node ids, the ACTIVE one (last clicked — the one the inspector shows) last. */
  selection: string[];
  /** Unity's Q W E R. */
  tool: "view" | "translate" | "rotate" | "scale";
  space: "local" | "world";
  /** Gizmo at the active object's pivot, or the selection's centre (Unity's Z toggle). */
  pivot: "pivot" | "center";
  /** Increment snapping while Cmd is held during a drag: metres and degrees. */
  snapMove: number;
  snapRotate: number;
  /** Chain that newly placed lights are appended to; null = leave them unpatched. */
  activeChain: string | null | undefined;
  tab: string;
  identify: boolean;
  walk: boolean;
  liveUrl: string;
  /** Stream the sequence preview to the lighting-client (Identify streams regardless). */
  liveOutput: boolean;
  /** Draw video surfaces in the viewport. */
  showSurfaces: boolean;
  /** Play the first video's sound while previewing. */
  sound: boolean;
  notice: { text: string; kind: "info" | "error"; at: number } | null;
}

const stored = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(`lighting-editor.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
};
export const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(`lighting-editor.${key}`, value);
  } catch {
    /* private window — fine, it just won't stick */
  }
};

let ui: UiState = {
  selection: [],
  tool: "translate",
  space: (stored("space", "local") as UiState["space"]),
  pivot: (stored("pivot", "pivot") as UiState["pivot"]),
  snapMove: Number(stored("snapMove", "0.25")) || 0.25,
  snapRotate: Number(stored("snapRotate", "15")) || 15,
  activeChain: undefined,
  tab: stored("tab", "inspector"),
  identify: false,
  walk: false,
  liveUrl: stored("liveUrl", "localhost:8091"),
  // Never restored: the wall should not light up because a page was reloaded.
  liveOutput: false,
  showSurfaces: stored("showSurfaces", "1") === "1",
  sound: stored("sound", "0") === "1",
  notice: null,
};
const uiListeners = new Set<() => void>();

export const getUi = () => ui;
export function setUi(patch: Partial<UiState>) {
  ui = { ...ui, ...patch };
  if (patch.tab) remember("tab", patch.tab);
  if (patch.liveUrl) remember("liveUrl", patch.liveUrl);
  if (patch.space) remember("space", patch.space);
  if (patch.pivot) remember("pivot", patch.pivot);
  if (patch.snapMove) remember("snapMove", String(patch.snapMove));
  if (patch.snapRotate) remember("snapRotate", String(patch.snapRotate));
  if (patch.showSurfaces !== undefined) remember("showSurfaces", patch.showSurfaces ? "1" : "0");
  if (patch.sound !== undefined) remember("sound", patch.sound ? "1" : "0");
  for (const fn of uiListeners) fn();
}
const subscribeUi = (fn: () => void) => {
  uiListeners.add(fn);
  return () => uiListeners.delete(fn);
};
export function useUi(): UiState {
  return useSyncExternalStore(subscribeUi, getUi);
}

export function notify(text: string, kind: "info" | "error" = "info") {
  setUi({ notice: { text, kind, at: Date.now() } });
}

/** The chain new lights go on: the chosen one if it still exists, else the first, else none. */
export function activeChainId(rig: RigDocument, chosen = ui.activeChain): string | null {
  if (chosen === null) return null;
  if (chosen && rig.chains.some((c) => c.id === chosen)) return chosen;
  return rig.chains[0]?.id ?? null;
}

/** The active (last-selected) node, or null. */
export const activeOf = (selection: readonly string[]): string | null => selection[selection.length - 1] ?? null;

/** Select exactly these (active last). */
export const select = (ids: string[]) => setUi({ selection: ids });
