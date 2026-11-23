// The one document store. EVERY edit to the rig goes through `edit()` — the viewport's gizmo, the
// inspector's fields, the patch panel, file loads — so undo/redo and autosave (milestone 6) can be
// added here without touching a single caller.
//
// Documents are treated as immutable values: an edit clones the current document, lets the caller
// mutate the clone, and swaps it in. Rigs are a few hundred nodes at most, so the clone is cheap,
// and the old value stays valid for anyone still holding it — which is exactly what an undo stack
// will need.

export interface EditRecord {
  label: string;
  /** Edits with the same key in quick succession (typing in a number field) are one undo step. */
  coalesce?: string;
  at: number;
}

export class DocStore<T> {
  private doc: T;
  private listeners = new Set<() => void>();
  private revision = 0;
  private savedRevision = 0;
  /** What happened, newest last. Milestone 6 turns this into an undo stack (it will keep `before`). */
  readonly journal: EditRecord[] = [];

  constructor(initial: T) {
    this.doc = initial;
  }

  get = (): T => this.doc;

  /** Apply one edit. Returns false (and changes nothing) if the recipe throws. */
  edit(label: string, recipe: (draft: T) => void, opts: { coalesce?: string } = {}): boolean {
    const draft = structuredClone(this.doc);
    try {
      recipe(draft);
    } catch (err) {
      console.warn(`[store] edit "${label}" failed:`, err);
      return false;
    }
    this.doc = draft;
    this.revision++;
    this.journal.push({ label, coalesce: opts.coalesce, at: Date.now() });
    if (this.journal.length > 500) this.journal.splice(0, this.journal.length - 500);
    this.emit();
    return true;
  }

  /** Replace the document wholesale (opening a file). Starts clean. */
  load(doc: T) {
    this.doc = doc;
    this.revision++;
    this.savedRevision = this.revision;
    this.journal.length = 0;
    this.emit();
  }

  /** Record that the document as of `revision` is what is on disk. */
  markSaved(revision = this.revision) {
    this.savedRevision = revision;
    this.emit();
  }

  get currentRevision() {
    return this.revision;
  }

  get dirty() {
    return this.revision !== this.savedRevision;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
