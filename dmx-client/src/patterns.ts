// Test patterns — the bench checks from the CL05 notes, as buttons instead of typed channel specs.
//
// A tube cannot report anything back; the only test there is, is to send a known pattern and look.
// Each pattern here answers one specific question about the rig, named in its `asks`.
//
// Patterns produce ordinary 8-bit show samples and go through the same output path as a show, so a
// pattern that looks right is also evidence that playback will. `level` is a perceptual level
// (0–1): 0.3 is dim, and is the default on purpose — the full-brightness power test of a long chain
// is still an open item, and a test pattern should not be the thing that runs it by accident.

export interface PatternContext {
  pixelCount: number;
  /** Pixels per fixture, for the patterns that think in tubes. */
  pixelsPerFixture: number;
  /** Frame-order index of the first pixel of every universe after the first. */
  universeStarts: number[];
  /** Perceptual level, 0–1. */
  level: number;
}

export interface Pattern {
  id: string;
  label: string;
  /** What looking at this pattern tells you. */
  asks: string;
  render(out: Uint8Array, tMs: number, ctx: PatternContext): void;
}

const set = (out: Uint8Array, pixel: number, r: number, g: number, b: number) => {
  const i = pixel * 3;
  out[i] = r;
  out[i + 1] = g;
  out[i + 2] = b;
};

const solid = (id: string, label: string, asks: string, rgb: [number, number, number]): Pattern => ({
  id,
  label,
  asks,
  render(out, _t, ctx) {
    const v = Math.round(ctx.level * 255);
    for (let p = 0; p < ctx.pixelCount; p++) set(out, p, rgb[0] * v, rgb[1] * v, rgb[2] * v);
  },
});

/** HSV with s = 1, as show samples. Good enough for a test rainbow; not a colour-managed hue. */
function hue(h: number, v: number): [number, number, number] {
  const x = (((h % 1) + 1) % 1) * 6;
  const f = x - Math.floor(x);
  const hi = Math.round(v * 255);
  const up = Math.round(v * f * 255);
  const down = Math.round(v * (1 - f) * 255);
  switch (Math.floor(x)) {
    case 0: return [hi, up, 0];
    case 1: return [down, hi, 0];
    case 2: return [0, hi, up];
    case 3: return [0, down, hi];
    case 4: return [up, 0, hi];
    default: return [hi, 0, down];
  }
}

export const PATTERNS: readonly Pattern[] = [
  solid("green", "Health check", "Is every tube steady green? A flickering or red tube is failing — and so will every tube after it look.", [0, 1, 0]),
  solid("red", "Red", "Is every pixel red? Green or blue here means the colour order is wrong.", [1, 0, 0]),
  solid("blue", "Blue", "Is every pixel blue?", [0, 0, 1]),
  solid("white", "White", "Is the white even along the chain? A yellow/red tail means voltage is sagging.", [1, 1, 1]),
  {
    id: "tube-chase",
    label: "Tube chase",
    asks: "Does one whole tube light at a time, in chain order, with no tube skipped or split?",
    render(out, t, ctx) {
      const tubes = Math.max(1, Math.ceil(ctx.pixelCount / ctx.pixelsPerFixture));
      const lit = Math.floor(t / 400) % tubes;
      const v = Math.round(ctx.level * 255);
      const start = lit * ctx.pixelsPerFixture;
      for (let p = start; p < Math.min(ctx.pixelCount, start + ctx.pixelsPerFixture); p++) set(out, p, v, v, v);
    },
  },
  {
    id: "pixel-chase",
    label: "Pixel chase",
    asks: "Does a short comet run the whole chain without stalling or jumping? A jump is a universe boundary patched wrong.",
    render(out, t, ctx) {
      const head = Math.floor((t / 1000) * 160) % ctx.pixelCount;
      const v = ctx.level * 255;
      for (let k = 0; k < 6; k++) {
        const p = (head - k + ctx.pixelCount) % ctx.pixelCount;
        const f = Math.round(v * (1 - k / 6));
        set(out, p, f, f, f);
      }
    },
  },
  {
    id: "boundaries",
    label: "Boundaries",
    asks: "Red on each tube's first pixel, blue on its last — do they sit exactly on the joins? Green-then-white mid-tube marks a universe boundary.",
    render(out, _t, ctx) {
      const v = Math.round(ctx.level * 255);
      for (let p = 0; p < ctx.pixelCount; p++) {
        const inTube = p % ctx.pixelsPerFixture;
        if (inTube === 0) set(out, p, v, 0, 0);
        else if (inTube === ctx.pixelsPerFixture - 1) set(out, p, 0, 0, v);
      }
      for (const start of ctx.universeStarts) {
        if (start > 0) set(out, start - 1, 0, v, 0);
        if (start < ctx.pixelCount) set(out, start, v, v, v);
      }
    },
  },
  {
    id: "count",
    label: "Tube numbers",
    asks: "Tube N shows N lit pixels (every fifth is red). Which physical tube is which position in the chain?",
    render(out, _t, ctx) {
      const v = Math.round(ctx.level * 255);
      for (let p = 0; p < ctx.pixelCount; p++) {
        const tube = Math.floor(p / ctx.pixelsPerFixture);
        const inTube = p % ctx.pixelsPerFixture;
        if (inTube > tube) continue;
        if ((inTube + 1) % 5 === 0) set(out, p, v, 0, 0);
        else set(out, p, v, v, v);
      }
    },
  },
  {
    id: "ramp",
    label: "Ramp",
    asks: "Each tube ramps dark to bright. Does it look like an even ramp? Bunched at the bright end means gamma is too low.",
    render(out, _t, ctx) {
      for (let p = 0; p < ctx.pixelCount; p++) {
        const f = (p % ctx.pixelsPerFixture) / Math.max(1, ctx.pixelsPerFixture - 1);
        const v = Math.round(f * ctx.level * 255);
        set(out, p, v, v, v);
      }
    },
  },
  {
    id: "breathe",
    label: "Breathe",
    asks: "The whole rig fades up and down over 6s. Is the bottom of the fade smooth, or does it step?",
    render(out, t, ctx) {
      const f = 0.5 - 0.5 * Math.cos((t / 6000) * Math.PI * 2);
      const v = Math.round(f * ctx.level * 255);
      for (let p = 0; p < ctx.pixelCount; p++) set(out, p, v, v, v);
    },
  },
  {
    id: "rainbow",
    label: "Rainbow",
    asks: "A moving rainbow across the whole chain — a general 'is it alive and in order' look.",
    render(out, t, ctx) {
      for (let p = 0; p < ctx.pixelCount; p++) {
        const [r, g, b] = hue(p / (ctx.pixelsPerFixture * 3) - t / 5000, ctx.level);
        set(out, p, r, g, b);
      }
    },
  },
];

export const patternById = (id: string): Pattern | undefined => PATTERNS.find((p) => p.id === id);
