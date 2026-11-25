import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPlan, evaluateFrame } from "../src/model/evaluate";
import { parseRig } from "../src/model/rig";
import { parseSequence, serializeSequence } from "../src/model/sequence";
import { recordedShow } from "../src/model/recorded";
import { bake } from "../src/bake/bake";
import { encodeFrame } from "../src/model/pixels";
import { encodeShowHeader, frameView, parseShow } from "../../dmx-client/src/shared/show-file";
import { alignOnboarding } from "../src/tools/import-onboarding";
import { Output } from "../../dmx-client/src/output";
import { validatePatch } from "../../dmx-client/src/shared/patch";

const root = path.resolve(import.meta.dir, "../project/pavotube");
const rig = parseRig(fs.readFileSync(path.join(root, "rig.json"), "utf8"));
const seq = parseSequence(fs.readFileSync(path.join(root, "sequences/soundspace-introduction.json"), "utf8"));

test("venue alignment removes only the return delay and holds the final tail", () => {
  const { show } = recordedShow(seq.recorded!);
  const raw = new Uint16Array(show.header.frameCount * show.header.pixelCount * 3);
  const stride = show.header.pixelCount * 3;
  for (let frame = 0; frame < show.header.frameCount; frame++) raw.fill(frame, frame * stride, (frame + 1) * stride);
  const source = Buffer.concat([encodeShowHeader(show.header), new Uint8Array(raw.buffer)]);
  const alignedBytes = alignOnboarding(source);
  const aligned = new Uint16Array(alignedBytes.buffer);
  for (let frame = 0; frame < show.header.frameCount; frame++) {
    const expected = frame < 6972 ? frame : Math.min(frame + 30, show.header.frameCount - 1);
    expect(aligned.subarray(frame * stride, (frame + 1) * stride).every(value => value === expected)).toBe(true);
  }
  expect(aligned.length).toBe(raw.length);
  expect(() => alignOnboarding(Buffer.concat([encodeShowHeader({ ...show.header, fps: 24 }), new Uint8Array(raw.buffer)]))).toThrow("Expected build-13");
});

test("eight-tube score survives pause/seek, wire reorder and black screen", () => {
  const plan = buildPlan(rig, seq);
  const frame = evaluateFrame(plan, () => null, undefined, 60000);
  expect(frame.some(x => x > 0)).toBe(true);
  evaluateFrame(plan, () => null, undefined, 150000);
  expect(evaluateFrame(plan, () => null, undefined, 60000)).toEqual(frame);
  const reordered = structuredClone(rig);
  reordered.chains[0]!.links.reverse();
  const other = evaluateFrame(buildPlan(reordered, seq), () => null, undefined, 60000);
  for (let tube = 0; tube < 8; tube++) expect(other.slice(tube * 48, tube * 48 + 48)).toEqual(frame.slice((7-tube)*48, (8-tube)*48));
  expect(evaluateFrame(plan, () => null, undefined, 210650).every(x => x === 0)).toBe(true);
});

test("full score preview round-trips to native output, cap and unused slots", () => {
  const { bytes, show } = recordedShow(seq.recorded!);
  expect(show.header.frameCount / show.header.fps).toBe(210.65);
  expect(show.header.experience).toBe("Introduction");
  expect(show.header.patch.runs.map(r => r.channel)).toEqual([1,49,97,145,193,241,289,337]);
  let sent = new Uint8Array(512);
  const output = new Output({ kind: "preview", label: "test", connected: false, error: null, packetsSent: 0, failures: 0,
    knownNodes: () => [], poll: async () => [], close: () => {},
    validatePatch, sendUniverse: (_h, _p, u, data) => { expect(u).toBe(1); sent = new Uint8Array(data); } });
  output.setPatch(show.header.patch); output.setLevels({ master: 1, cap: .5 });
  const plan = buildPlan(rig, seq), out = new Float32Array(384);
  for (let i = 0; i < show.header.frameCount; i++) {
    const original = frameView(bytes, show, i);
    if (!(original instanceof Uint16Array)) throw new Error("Expected RGB16 score");
    const encoded = encodeFrame(evaluateFrame(plan, () => null, out, i * 25), 16);
    expect(new Uint16Array(encoded.buffer)).toEqual(original);
    output.render(original, show.header.transfer);
    expect(sent.slice(384).every(v => v === 0)).toBe(true);
    expect(sent.every(v => v <= 128)).toBe(true);
  }
  output.render(null); expect(sent.every(v => v === 0)).toBe(true);
});

test("recorded bake needs no video or ffmpeg and rejects corrupted scores", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbe-score-test-"));
  try {
    const result = await bake({rig, sequence: seq, showsDir: dir, probe: async () => { throw new Error("Video should not drive recorded lighting"); }});
    const baked = fs.readFileSync(result.file), original = recordedShow(seq.recorded!);
    expect(baked.subarray(parseShow(baked).dataOffset)).toEqual(Buffer.from(original.bytes.subarray(original.show.dataOffset)));
    const broken = structuredClone(seq);
    broken.recorded!.showBase64 = Buffer.from(original.bytes.subarray(0, 5000)).toString("base64");
    expect(() => parseSequence(serializeSequence(broken))).toThrow("truncated");
    const wrong = structuredClone(rig); wrong.profiles[0]!.pixels = 15;
    expect(() => buildPlan(wrong, seq)).toThrow("expects 16 pixels");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
