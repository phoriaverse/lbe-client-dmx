import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { frameView, parseShow } from "../../dmx-client/src/shared/show-file";
import { bake } from "../src/bake/bake";
import { buildPlan, evaluateFrame, type Picture } from "../src/model/evaluate";
import { addSurface, addTube } from "../src/model/ops";
import { encodeFrame } from "../src/model/pixels";
import { newRig } from "../src/model/rig";
import { newSequence, parseSequence, serializeSequence } from "../src/model/sequence";

const picture: Picture = { width: 2, height: 2, stride: 3, data: new Uint8Array(12) };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbe-unison-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
function project() {
  const rig = newRig();
  addTube(rig); addTube(rig, { transform: { position: [100, 10, 50], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  const screen = addSurface(rig);
  const sequence = newSequence("unison", "Unison");
  sequence.level = 0.4; sequence.sampling = "unison"; sequence.durationMs = 400;
  sequence.surfaces[screen] = { video: "trimmed.mp4", gain: 1 };
  sequence.unison = { video: "trimmed.mp4", source: "original.mp4", sourceStartMs: 18000, color: [144, 2, 255], fps: 10, intensities: [0, 1, 0.5, 0], description: "Video + audio" };
  return { rig, sequence };
}

test("unison is independent of position and seeks use absolute sequence time", () => {
  const { rig, sequence } = project();
  const plan = buildPlan(rig, sequence);
  for (const [time, expectedBlue] of [[100, 0.4], [150, 0.3], [0, 0], [200, 0.2]]) {
    const frame = evaluateFrame(plan, () => picture, undefined, time);
    expect(frame[2]).toBeCloseTo(expectedBlue!, 6);
    for (let i = 0; i < frame.length; i += 3) expect(Array.from(frame.slice(i, i + 3))).toEqual(Array.from(frame.slice(0, 3)));
  }
  expect(evaluateFrame(plan, () => null, undefined, 100).every((v) => v === 0)).toBe(true);
  expect(evaluateFrame(plan, () => picture, undefined, 400).every((v) => v === 0)).toBe(true);
});

test("saved unison tracks reject invalid samples and a mismatched playback video", () => {
  const { sequence } = project();
  expect(parseSequence(serializeSequence(sequence))).toEqual(sequence);
  sequence.unison!.intensities[0] = 2;
  expect(() => parseSequence(serializeSequence(sequence))).toThrow("intensities");
  sequence.unison!.intensities[0] = 0;
  sequence.unison!.video = "wrong.mp4";
  expect(() => parseSequence(serializeSequence(sequence))).toThrow("assigned to a screen");
});

test("bake follows the same timed envelope as preview at a different frame rate", async () => {
  const { rig, sequence } = project();
  const result = await bake({ rig, sequence, showsDir: dir, resolve: (name) => name,
    probe: async () => ({ width: 2, height: 2, durationMs: 400, fps: 40 }),
    decoder: () => ({ next: async () => picture, close() {} }),
  });
  const bytes = new Uint8Array(fs.readFileSync(result.file)), show = parseShow(bytes, bytes.length);
  const plan = buildPlan(rig, sequence);
  expect(show.header.frameCount).toBe(16);
  for (let f = 0; f < 16; f++) {
    const expected = encodeFrame(evaluateFrame(plan, () => picture, undefined, f * 25));
    expect(Array.from(frameView(bytes, show, f))).toEqual(Array.from(expected));
  }
  expect(frameView(bytes, show, 4)[2]).toBeGreaterThan(frameView(bytes, show, 8)[2]!);
});
