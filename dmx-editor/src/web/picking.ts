// Selection rules from Unity's Scene View, kept pure so they can be tested without a viewport.

/**
 * What a click picks. `hits` are the objects under the cursor, nearest first. A repeated click on
 * the same spot (same objects under it) steps past the currently active object to the next one
 * behind it, wrapping round — how Unity reaches an object hidden behind another.
 */
export function pickAt(hits: readonly string[], active: string | null, sameSpot: boolean): string | null {
  if (!hits.length) return null;
  if (sameSpot && active) {
    const i = hits.indexOf(active);
    if (i >= 0) return hits[(i + 1) % hits.length]!;
  }
  return hits[0]!;
}

/** A click's effect on the selection: plain replaces (or clears on empty space); ⇧/⌘ toggles. */
export function applyClick(selection: readonly string[], picked: string | null, toggle: boolean): string[] {
  if (!toggle) return picked ? [picked] : [];
  if (!picked) return [...selection];
  return selection.includes(picked) ? selection.filter((x) => x !== picked) : [...selection, picked];
}

/** A rectangle select: plain replaces, ⇧ adds, ⌘ removes. */
export function applyRect(base: readonly string[], inside: readonly string[], mode: "replace" | "add" | "remove"): string[] {
  if (mode === "remove") return base.filter((id) => !inside.includes(id));
  if (mode === "add") return [...base, ...inside.filter((id) => !base.includes(id))];
  return [...inside];
}
