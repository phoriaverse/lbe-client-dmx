import { describe, expect, test } from "bun:test";
import { chainRuns, compilePatch, describePatch, endOfRun, simplePatch, validatePatch, type Patch } from "../src/shared/patch";

// The reference is the CL05 bench table: 32 GRB pixels a tube, 170 pixels a universe, and tube
// boundaries that do NOT line up with universe boundaries.
const bench = () => simplePatch({ host: "2.0.0.100", fixtures: 21, pixelsPerFixture: 32 });

describe("chain packing", () => {
  test("matches the bench-verified channel table for tubes 1–5", () => {
    const runs = bench().runs;
    expect(runs.slice(0, 5).map((r) => [r.universe, r.channel])).toEqual([
      [0, 1],
      [0, 97],
      [0, 193],
      [0, 289],
      [0, 385],
    ]);
  });

  test("tube 6 starts at channel 481 and spills into universe 1 after pixel 170", () => {
    const compiled = compilePatch(bench());
    const tube6 = compiled.patch.runs[5]!;
    expect([tube6.universe, tube6.channel]).toEqual([0, 481]);
    // pixel 170 (1-based) is the last in universe 0, on channels 508–510
    expect([compiled.slotOf[169], compiled.offsetOf[169]]).toEqual([0, 507]);
    // pixel 171 is the first in universe 1, on channel 1 — never straddling the boundary
    expect([compiled.slotOf[170], compiled.offsetOf[170]]).toEqual([1, 0]);
    expect(compiled.slots[1]!.universe).toBe(1);
  });

  test("every pixel follows universe = floor(n/170), channel = 3·(n mod 170) + 1", () => {
    const compiled = compilePatch(bench());
    for (let n = 0; n < 672; n++) {
      expect(compiled.slots[compiled.slotOf[n]!]!.universe).toBe(Math.floor(n / 170));
      expect(compiled.offsetOf[n]).toBe(3 * (n % 170));
    }
  });

  test("21 tubes need four universes", () => {
    const compiled = compilePatch(bench());
    expect(compiled.slots.map((s) => s.universe)).toEqual([0, 1, 2, 3]);
    expect(compiled.slots.map((s) => s.used)).toEqual([510, 510, 510, 486]);
    expect(describePatch(compiled)).toBe("672 px · 1 gateway · 4 universes (0–3)");
  });

  test("endOfRun reports where the next fixture goes, including across a wrap", () => {
    expect(endOfRun({ count: 32, universe: 0, channel: 1, order: "GRB" })).toEqual({ universe: 0, channel: 97 });
    expect(endOfRun({ count: 170, universe: 0, channel: 1, order: "GRB" })).toEqual({ universe: 1, channel: 1 });
    expect(endOfRun({ count: 32, universe: 0, channel: 481, order: "GRB" })).toEqual({ universe: 1, channel: 67 });
  });

  test("four-channel pixels pack 128 to a universe", () => {
    const patch: Patch = { pixelCount: 130, gateways: [{ id: "g", host: "h" }], runs: chainRuns("g", [{ count: 130, order: "GRBW", gamma: 2.2 }]) };
    const compiled = compilePatch(patch);
    expect([compiled.slotOf[127], compiled.offsetOf[127]]).toEqual([0, 508]);
    expect([compiled.slotOf[128], compiled.offsetOf[128]]).toEqual([1, 0]);
  });

  test("a chain can start mid-universe on a later universe", () => {
    const runs = chainRuns("g", [{ count: 4, order: "RGB", gamma: 1 }], { first: 10, universe: 7, channel: 505 });
    const compiled = compilePatch({ pixelCount: 14, gateways: [{ id: "g", host: "h" }], runs });
    expect(compiled.slots.map((s) => s.universe)).toEqual([7, 8]);
    expect([compiled.offsetOf[10], compiled.offsetOf[11], compiled.offsetOf[12]]).toEqual([504, 507, 0]);
    expect(compiled.slotOf[0]).toBe(-1); // unpatched pixels stay unpatched
  });
});

describe("validation", () => {
  test("a clean patch has no problems", () => {
    expect(validatePatch(bench())).toEqual([]);
  });

  test("two runs on the same channels are reported", () => {
    const patch = bench();
    patch.runs[1] = { ...patch.runs[1]!, channel: 90 };
    expect(validatePatch(patch).join(" ")).toContain("both write");
  });

  test("the same channels on DIFFERENT gateways are fine", () => {
    const patch: Patch = {
      pixelCount: 64,
      gateways: [{ id: "a", host: "2.0.0.100" }, { id: "b", host: "2.0.0.101" }],
      runs: [...chainRuns("a", [{ count: 32, order: "GRB", gamma: 2.2 }]), ...chainRuns("b", [{ count: 32, order: "GRB", gamma: 2.2 }], { first: 32 })],
    };
    expect(validatePatch(patch)).toEqual([]);
    expect(compilePatch(patch).slots.length).toBe(2);
  });

  test("unknown gateway, overrun and a doubly-patched pixel are each reported", () => {
    const patch = bench();
    expect(validatePatch({ ...patch, runs: [{ ...patch.runs[0]!, gateway: "nope" }] }).join(" ")).toContain("unknown gateway");
    expect(validatePatch({ ...patch, pixelCount: 600 }).join(" ")).toContain("runs past the frame");
    expect(validatePatch({ ...patch, runs: [patch.runs[0]!, { ...patch.runs[1]!, first: 16 }] }).join(" ")).toContain("patched twice");
  });

  test("compilePatch refuses an invalid patch", () => {
    expect(() => compilePatch({ ...bench(), pixelCount: 10 })).toThrow("invalid patch");
  });
});
