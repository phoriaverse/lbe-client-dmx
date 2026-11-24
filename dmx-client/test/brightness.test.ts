import { describe, expect, test } from "bun:test";
import { Output } from "../src/output";
import { simplePatch } from "../src/shared/patch";
import { PreviewTransport } from "../src/transport";
import { patternById } from "../src/patterns";
import { encodeFrame, estimateFixtureFrame } from "../../dmx-editor/src/model/pixels";
import { compileRigPatch } from "../../dmx-editor/src/model/patch";
import { parseRig } from "../../dmx-editor/src/model/rig";
import { linearToSrgb } from "../src/shared/brightness";

const pavotube = parseRig(await Bun.file(new URL("../../dmx-editor/project/pavotube/rig.json", import.meta.url)).text());

function rig(gamma: number) {
  const output = new Output(new PreviewTransport());
  const patch = simplePatch({ host: "preview", fixtures: 1, pixelsPerFixture: 16 });
  output.setPatch({ ...patch, runs: patch.runs.map((run) => ({ ...run, gamma })) });
  return output;
}

describe("fixture appearance monitor", () => {
  test("gamma 1 does not get mistaken for linear DMX in the screen preview", () => {
    const output = rig(1);
    output.render(new Uint8Array(48).fill(128));
    expect(output.lastDriveLevels[0]).toBe(128);
    // The configured response is light = drive^2.2, then encoded as sRGB for the screen.
    // The old UI displayed 186 here by incorrectly assuming light = drive.
    expect(output.lastDisplayLevels[0]).toBe(129);
  });

  test("linear and curved fixtures display the same intended light, within DMX quantisation", () => {
    const linear = rig(2.2), curved = rig(1);
    for (const output of [linear, curved]) {
      output.setLevels({ master: 0.5, cap: 0.5 });
      output.render(new Uint8Array(48).fill(255));
    }
    expect(linear.lastDriveLevels[0]).toBe(64);
    expect(curved.lastDriveLevels[0]).toBe(136);
    expect(linear.lastDisplayLevels[0]).toBe(137);
    expect(Math.abs(linear.lastDisplayLevels[0]! - curved.lastDisplayLevels[0]!)).toBeLessThanOrEqual(1);
  });

  test("blackout clears both monitors and a changed patch rebuilds the appearance curve", () => {
    const output = rig(1);
    output.render(new Uint8Array(48).fill(128));
    output.render(null);
    expect(output.lastDisplayLevels.every((v) => v === 0)).toBe(true);
    expect(output.lastDriveLevels.every((v) => v === 0)).toBe(true);
    const patch = output.patch!;
    output.setPatch({ ...patch, runs: patch.runs.map((run) => ({ ...run, gamma: 2.2 })) });
    output.render(new Uint8Array(48).fill(128), 1);
    expect(output.lastDisplayLevels[0]).toBe(188);
  });
});

describe("ramp comparisons through actual output", () => {
  const render = (id: string, level = 1) => {
    const output = rig(2.2);
    output.setLevels({ master: 1, cap: 0.5 });
    const frame = new Uint8Array(48);
    patternById(id)!.render(frame, 0, { pixelCount: 16, pixelsPerFixture: 16, universeStarts: [], level });
    output.render(frame);
    return Array.from(output.lastDriveLevels.filter((_, i) => i % 3 === 0));
  };

  test("linear-light ramp has equal light steps; perceptual ramp has a darker midpoint", () => {
    const linear = render("ramp"), perceptual = render("perceptual-ramp");
    for (let i = 0; i < 16; i++) {
      expect(Math.abs(linear[i]! - i / 15 * 127.5)).toBeLessThanOrEqual(1);
      expect(perceptual[i]!).toBeLessThanOrEqual(linear[i]!);
      if (i) expect(perceptual[i]!).toBeGreaterThanOrEqual(perceptual[i - 1]!);
    }
    expect(perceptual[0]).toBe(0);
    expect(perceptual[15]).toBe(linear[15]!);
    expect(perceptual[8]).toBeGreaterThanOrEqual(27);
    expect(perceptual[8]).toBeLessThanOrEqual(28);
  });

  test("both ramps preserve the same peak and respect master/cap at every pattern level", () => {
    for (const level of [0, 0.3, 0.6, 1]) {
      const linear = render("ramp", level), perceptual = render("perceptual-ramp", level);
      expect(perceptual[15]).toBe(linear[15]!);
      expect(Math.max(...perceptual)).toBeLessThanOrEqual(128);
      expect(Math.abs(perceptual[15]! - Math.pow(level, 2.2) * 127.5)).toBeLessThanOrEqual(1);
    }
  });
});

test("PavoTube profile matches the user's Linear DMX mode and editor brightness matches the client", () => {
  expect(pavotube.profiles[0]!.gamma).toBe(2.2);
  for (const gamma of [1, 2.2]) {
    const document = structuredClone(pavotube);
    document.profiles[0]!.gamma = gamma;
    document.profiles[0]!.gain = [1, 0.8, 0.6];
    const patch = compileRigPatch(document);
    const frame = Float32Array.from({ length: patch.pixelCount * 3 }, (_, i) => (i % 16) / 15 * 0.3);
    const output = new Output(new PreviewTransport());
    output.setPatch(patch);
    output.setLevels({ master: 0.6, cap: 0.5 });
    output.render(encodeFrame(frame));
    const estimate = estimateFixtureFrame(document, frame, 0.6 * 0.5);
    const screen = Array.from(estimate, (v) => Math.round(linearToSrgb(v) * 255));
    expect(screen).toEqual(Array.from(output.lastDisplayLevels));
    expect(Math.max(...estimate)).toBeLessThan(0.1);
    expect(estimateFixtureFrame(document, frame, 0).every((v) => v === 0)).toBe(true);
  }
});
