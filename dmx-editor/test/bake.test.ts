import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { frameView, parseShow } from "../../dmx-client/src/shared/show-file";
import { bake } from "../src/bake/bake";
import type { Decoder } from "../src/bake/media";
import { buildPlan, evaluateFrame, type Picture } from "../src/model/evaluate";
import { addRail, addSurface, updateSurface } from "../src/model/ops";
import { compileRigPatch } from "../src/model/patch";
import { encodeFrame } from "../src/model/pixels";
import { newRig } from "../src/model/rig";
import { newSequence, setSurfaceUse } from "../src/model/sequence";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbe-bake-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Picture n is a flat grey of level n (mod 256), so every frame is distinguishable. */
const picture = (n: number, w: number, h: number): Picture => ({ width: w, height: h, stride: 3, data: new Uint8Array(w * h * 3).fill(n % 256) });

/** A stand-in for ffmpeg: `frames` pictures, then the end of the video. */
const fakeDecoder = (frames: number) => (_file: string, o: { width: number; height: number }): Decoder => {
  let n = 0;
  return { next: async () => (n < frames ? picture(n++, o.width, o.height) : null), close() {} };
};

function project() {
  const rig = newRig();
  addRail(rig, { tubes: 3 });
  const surface = addSurface(rig);
  updateSurface(rig, surface, { width: 2, height: 1 });
  const seq = newSequence("second-nature", "Second Nature");
  setSurfaceUse(seq, surface, { video: "clip.mp4" });
  return { rig, seq };
}

const fakes = (seconds: number, frames: number) => ({
  resolve: (v: string) => `/nowhere/${v}`,
  probe: async () => ({ width: 1920, height: 1080, durationMs: seconds * 1000, fps: 30 }),
  decoder: fakeDecoder(frames),
});

describe("the bake", () => {
  test("writes a .show the client's parser accepts, whose frames are the evaluator's", async () => {
    const { rig, seq } = project();
    const result = await bake({ rig, sequence: seq, showsDir: dir, ...fakes(2, 80) });

    expect(path.basename(result.file)).toBe("second-nature.show");
    expect(result.frameCount).toBe(80); // 2 s at 40 fps
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

    const bytes = new Uint8Array(fs.readFileSync(result.file));
    const show = parseShow(bytes, bytes.length);
    expect(show.header.experience).toBe("Second Nature");
    expect(show.header.fps).toBe(40);
    expect(show.header.patch).toEqual(compileRigPatch(rig));
    expect(show.header.pixelCount).toBe(96);
    expect(show.header.hashes?.rig).toBeTruthy();

    const plan = buildPlan(rig, seq);
    for (const f of [0, 1, 37, 79]) {
      const expected = encodeFrame(evaluateFrame(plan, () => picture(f, 256, 144)), 8);
      expect(Array.from(frameView(bytes, show, f))).toEqual(Array.from(expected));
    }
    // And it is not trivially dark: grey 79 at level 0.35 is a visible sample.
    expect(frameView(bytes, show, 79)[0]).toBeGreaterThan(0);
  });

  test("16-bit, an overridden length, and a video that ends early (dark after, with a warning)", async () => {
    const { rig, seq } = project();
    seq.bits = 16;
    seq.fps = 25;
    seq.durationMs = 4000;
    const result = await bake({ rig, sequence: seq, showsDir: dir, ...fakes(2, 50) });
    expect(result.frameCount).toBe(100);
    expect(result.warnings.some((w) => w.includes("clip.mp4 ends"))).toBe(true);
    const bytes = new Uint8Array(fs.readFileSync(result.file));
    const show = parseShow(bytes, bytes.length);
    expect(frameView(bytes, show, 49)[0]).toBeGreaterThan(0);
    expect(Array.from(frameView(bytes, show, 50)).every((v) => v === 0)).toBe(true);
  });

  test("refuses a rig the client would refuse, a missing video and a sequence with no length — leaving nothing behind", async () => {
    const before = fs.readdirSync(dir).sort();
    const { rig, seq } = project();
    await expect(bake({ rig, sequence: seq, showsDir: dir, ...fakes(2, 80), resolve: () => null })).rejects.toThrow(/clip\.mp4 is not in/);

    const overlapping = structuredClone(rig);
    overlapping.chains.push({ ...structuredClone(overlapping.chains[0]!), id: "chain2", name: "Chain 2", links: [] });
    overlapping.chains[1]!.links.push(overlapping.chains[0]!.links.pop()!);
    await expect(bake({ rig: overlapping, sequence: seq, showsDir: dir, ...fakes(2, 80) })).rejects.toThrow(/rig has problems/);

    const empty = structuredClone(seq);
    empty.surfaces = {};
    await expect(bake({ rig, sequence: empty, showsDir: dir, ...fakes(2, 80) })).rejects.toThrow(/no length/);

    const failing = { ...fakes(2, 80), decoder: (): Decoder => ({ next: async () => { throw new Error("ffmpeg failed"); }, close() {} }) };
    await expect(bake({ rig, sequence: { ...seq, experience: "Other" }, showsDir: dir, ...failing })).rejects.toThrow(/ffmpeg failed/);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });
});
