import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { bake } from "../src/bake/bake";
import { parseRig } from "../src/model/rig";
import { parseSequence } from "../src/model/sequence";
import { buildPlan, evaluateFrame, type Picture } from "../src/model/evaluate";
import { encodeFrame } from "../src/model/pixels";
import { frameView, parseShow } from "../../dmx-client/src/shared/show-file";
import { ShowLibrary } from "../../dmx-client/src/shows";

test("the full Introduction bakes for journey playback and preserves the independent rehearsal", async () => {
  const project = path.join(import.meta.dir, "../project/pavotube");
  const sequence = parseSequence(fs.readFileSync(path.join(project, "sequences/soundspace-introduction.json"), "utf8"));
  const timing = JSON.parse(fs.readFileSync(path.join(project, "introduction-timing.json"), "utf8"));
  const rehearsal = fs.readFileSync(path.join(project, "sequences/intro-lissajous.json"));
  expect(createHash("sha256").update(rehearsal).digest("hex")).toBe(timing.rehearsal.sha256);
  expect(parseSequence(rehearsal.toString()).durationMs).toBe(26400);
  expect(sequence.experience).toBe("Introduction");
  expect(sequence.durationMs).toBe(210660);
  expect(timing.phases.find((p: { name: string }) => p.name === "Bass Mosaic").time).toBe(174.3);
  const rig = parseRig(fs.readFileSync(path.join(project, "rig.json"), "utf8"));
  const picture: Picture = { width: 2, height: 2, stride: 3, data: new Uint8Array(12) };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "introduction-bake-"));
  try {
    const result = await bake({ rig, sequence, showsDir: directory, resolve: name => name,
      probe: async () => ({ width: 2, height: 2, durationMs: 210660, fps: 20 }),
      decoder: () => ({ next: async () => picture, close() {} }) });
    expect(path.basename(result.file)).toBe("introduction.show");
    expect(result.frameCount).toBe(8426);
    const library = new ShowLibrary(directory);
    library.scan();
    expect(library.find("Introduction")?.file).toBe("introduction.show");
    const bytes = new Uint8Array(fs.readFileSync(result.file));
    const show = parseShow(bytes, bytes.length), plan = buildPlan(rig, sequence);
    expect(show.header.pixelCount).toBe(128);
    for (const frame of [0, 80, 1706, 3200, 6000, 6972, 8425]) {
      const actual = frameView(bytes, show, frame);
      const expected = encodeFrame(evaluateFrame(plan, () => picture, undefined, frame * 25));
      expect(actual).toEqual(expected);
      for (let pixel = 1; pixel < 128; pixel++) expect(actual.slice(pixel * 3, pixel * 3 + 3)).toEqual(actual.slice(0, 3));
    }
    expect(frameView(bytes, show, 0).every(v => v === 0)).toBe(true);
    expect(frameView(bytes, show, 8425).every(v => v === 0)).toBe(true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
