import { describe, expect, test } from "bun:test";
import { buildPlan, evaluateFrame, type Picture } from "../src/model/evaluate";
import { addSurface, addTube, setTransform, updateSurface } from "../src/model/ops";
import { newRig, parseRig, type RigDocument, serializeRig, defaultSurface } from "../src/model/rig";
import { newSequence, parseSequence, sampleDims, type SequenceDocument, sequenceDurationMs, serializeSequence, setSurfaceUse } from "../src/model/sequence";
import { nearestLocal, projectLocal, surfaceMesh } from "../src/model/surfaces";
import { identityTransform, type Vec3 } from "../src/model/transform";

const srgbToLinear = (b: number) => {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** A picture whose red is a left→right ramp, green a top→bottom ramp, blue constant. */
function ramp(width: number, height: number, stride: 3 | 4 = 3): Picture {
  const data = new Uint8Array(width * height * stride);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * stride;
      data[o] = Math.round((x / (width - 1)) * 255);
      data[o + 1] = Math.round((y / (height - 1)) * 255);
      data[o + 2] = 128;
      if (stride === 4) data[o + 3] = 255;
    }
  return { width, height, stride, data };
}

/** One 32-pixel tube along X at the origin, and a planar surface over it. */
function scene(): { rig: RigDocument; seq: SequenceDocument; surface: string } {
  const rig = newRig();
  addTube(rig);
  const surface = addSurface(rig, { projection: "planar" });
  updateSurface(rig, surface, { width: 0.5, height: 0.25 });
  const seq = newSequence();
  seq.level = 1;
  setSurfaceUse(seq, surface, { video: "v.mp4" });
  return { rig, seq, surface };
}

describe("surfaces", () => {
  test("every mesh vertex projects back to its own picture coordinate", () => {
    for (const projection of ["planar", "dome", "equirect"] as const) {
      const s = { ...defaultSurface(projection), fov: 200 };
      const mesh = surfaceMesh(s);
      let checked = 0;
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        const p: Vec3 = [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
        const [u, v] = [mesh.uvs[i * 2]!, mesh.uvs[i * 2 + 1]!];
        // Skip the points where one place has many coordinates: the equirect seam and poles, the dome's zenith.
        if (projection === "equirect" && (u < 1e-6 || u > 1 - 1e-6 || v < 1e-6 || v > 1 - 1e-6)) continue;
        if (projection === "dome" && Math.hypot(u - 0.5, v - 0.5) < 1e-6) continue;
        const uv = projectLocal(s, p)!;
        expect(uv).not.toBeNull();
        expect(Math.abs(uv[0] - u)).toBeLessThan(1e-5);
        expect(Math.abs(uv[1] - v)).toBeLessThan(1e-5);
        checked++;
      }
      expect(checked).toBeGreaterThan(3);
    }
  });

  test("the conventions: planar right/up, dome zenith and front, equirect front", () => {
    const planar = defaultSurface("planar"); // 3.2 × 1.8
    expect(projectLocal(planar, [1.6, 0.9, 5])).toEqual([1, 0]); // +X +Y = top right, depth ignored
    expect(projectLocal(planar, [1.7, 0, 0])).toBeNull();
    const dome = defaultSurface("dome");
    expect(projectLocal(dome, [0, 2, 0])).toEqual([0.5, 0.5]); // straight up = picture centre
    const front = projectLocal(dome, [0, 0, -4])!; // horizon, front (−Z) = bottom centre
    expect(front[0]).toBeCloseTo(0.5);
    expect(front[1]).toBeCloseTo(1);
    expect(projectLocal(dome, [0, -1, -1])).toBeNull(); // below the rim
    const eq = defaultSurface("equirect");
    const f = projectLocal(eq, [0, 0, -2])!;
    expect(f[0]).toBeCloseTo(0.5);
    expect(f[1]).toBeCloseTo(0.5);
    expect(projectLocal(eq, [1, 0, 0])![0]).toBeCloseTo(0.75); // +X is a quarter turn to the right
    expect(projectLocal(eq, [0, 1, 0])![1]).toBeCloseTo(0); // up = top row
  });

  test("nearest always answers, and agrees with projection where projection answers", () => {
    const planar = defaultSurface("planar");
    expect(nearestLocal(planar, [9, 0, 2])).toEqual({ point: [1.6, 0, 0], uv: [1, 0.5] });
    const dome = defaultSurface("dome");
    const below = nearestLocal(dome, [0, -1, -1]);
    expect(below.uv[1]).toBeCloseTo(1); // slid up to the rim, at the front
    expect(below.point[1]).toBeCloseTo(0);
    for (const s of [planar, dome, defaultSurface("equirect")]) {
      const p: Vec3 = [0.4, 0.6, -0.9];
      const a = projectLocal(s, p)!;
      const b = nearestLocal(s, p).uv;
      expect(a[0]).toBeCloseTo(b[0]);
      expect(a[1]).toBeCloseTo(b[1]);
    }
  });
});

describe("the evaluator", () => {
  test("a tube under a planar surface reads the picture left to right, in linear light", () => {
    const { rig, seq } = scene();
    const plan = buildPlan(rig, seq);
    expect(plan.surfaces[0]!.pixels.length).toBe(32);
    // 32 texels across a 0.5 m surface, 32 pixels along a 0.5 m tube: pixel i sits on texel i's centre.
    const pic = ramp(32, 2);
    const frame = evaluateFrame(plan, () => pic);
    for (let i = 0; i < 32; i++) {
      expect(frame[i * 3]).toBeCloseTo(srgbToLinear(Math.round((i / 31) * 255)), 5);
      expect(frame[i * 3 + 2]).toBeCloseTo(srgbToLinear(128), 5);
    }
    // The tube lies on the surface's horizontal centre line: half way between the two rows.
    expect(frame[1]).toBeCloseTo((srgbToLinear(0) + srgbToLinear(255)) / 2, 5);
  });

  test("RGBA pictures (the browser's) and RGB pictures (ffmpeg's) evaluate identically", () => {
    const { rig, seq } = scene();
    const plan = buildPlan(rig, seq);
    expect(evaluateFrame(plan, () => ramp(64, 36, 4))).toEqual(evaluateFrame(plan, () => ramp(64, 36, 3)));
  });

  test("level and gain scale linear light; the result is clamped; no picture means dark", () => {
    const { rig, seq, surface } = scene();
    const white: Picture = { width: 2, height: 2, stride: 3, data: new Uint8Array(12).fill(255) };
    seq.level = 0.35;
    setSurfaceUse(seq, surface, { gain: 0.5 });
    expect(evaluateFrame(buildPlan(rig, seq), () => white)[0]).toBeCloseTo(0.175, 6);
    setSurfaceUse(seq, surface, { gain: 9 });
    expect(evaluateFrame(buildPlan(rig, seq), () => white)[0]).toBe(1);
    expect(evaluateFrame(buildPlan(rig, seq), () => null).every((v) => v === 0)).toBe(true);
  });

  test("projection leaves uncovered pixels dark; nearest lights every pixel from the closest surface", () => {
    const { rig, seq, surface } = scene();
    // Slide the surface half its width along the tube: only half the tube is under it now.
    setTransform(rig, surface, { ...identityTransform(), position: [0.25, 0, 0] });
    const white: Picture = { width: 2, height: 2, stride: 3, data: new Uint8Array(12).fill(255) };
    const projected = evaluateFrame(buildPlan(rig, seq), () => white);
    expect(projected[0]).toBe(0);
    expect(projected[31 * 3]).toBe(1);
    expect(buildPlan(rig, seq).surfaces[0]!.pixels.length).toBe(16);

    seq.sampling = "nearest";
    expect(evaluateFrame(buildPlan(rig, seq), () => white).every((v) => v === 1)).toBe(true);

    // A second surface, far to the left with a different video, takes the pixels nearer to it.
    const other = addSurface(rig, { projection: "planar", transform: { ...identityTransform(), position: [-3.2, 0, 0] } });
    updateSurface(rig, other, { width: 0.5, height: 0.25 });
    setSurfaceUse(seq, other, { video: "black.mp4" });
    const black: Picture = { width: 2, height: 2, stride: 3, data: new Uint8Array(12) };
    const plan = buildPlan(rig, seq);
    expect(plan.surfaces.map((s) => s.pixels.length).reduce((a, b) => a + b)).toBe(32);
    const frame = evaluateFrame(plan, (v) => (v === "black.mp4" ? black : white));
    expect(frame[31 * 3]).toBe(1);
  });

  test("a surface follows its parent's transform, like a light does", () => {
    const { rig, seq, surface } = scene();
    setTransform(rig, surface, { position: [0, 0, 0], rotation: [0, 180, 0], scale: [1, 1, 1] });
    const frame = evaluateFrame(buildPlan(rig, seq), () => ramp(32, 2));
    // Turned to face the other way, picture-right is now −X: the ramp runs backwards along the tube.
    expect(frame[0]).toBeCloseTo(1, 5);
    expect(frame[31 * 3]).toBeCloseTo(0, 5);
  });

  test("an equirect picture blends across its seam instead of clamping", () => {
    const rig = newRig();
    addTube(rig, { transform: { position: [0, 0, 1], rotation: [0, 0, 0], scale: [0.001, 1, 1] } }); // all pixels at the back (+Z): u = 0 / 1
    const surface = addSurface(rig, { projection: "equirect" });
    const seq = newSequence();
    seq.level = 1;
    setSurfaceUse(seq, surface, { video: "v.mp4" });
    // Left column black, right column white: at the seam a pixel sits between them.
    const pic: Picture = { width: 2, height: 1, stride: 3, data: Uint8Array.from([0, 0, 0, 255, 255, 255]) };
    const frame = evaluateFrame(buildPlan(rig, seq), () => pic);
    expect(frame[15 * 3]).toBeGreaterThan(0.3);
    expect(frame[15 * 3]).toBeLessThan(0.7);
  });
});

describe("the sequence document", () => {
  test("round-trips byte for byte, and surfaces survive a rig round trip", () => {
    const { rig, seq } = scene();
    const text = serializeSequence(seq);
    expect(serializeSequence(parseSequence(text))).toBe(text);
    expect(serializeRig(parseRig(serializeRig(rig)))).toBe(serializeRig(rig));
    expect(() => parseSequence(text.replace('"sampling": "projection"', '"sampling": "magic"'))).toThrow();
  });

  test("length follows the longest video in use unless overridden", () => {
    const { rig, seq } = scene();
    const durations = (v: string) => ({ "v.mp4": 195_267 })[v];
    expect(sequenceDurationMs(rig, seq, durations)).toBe(195_267);
    seq.durationMs = 60_000;
    expect(sequenceDurationMs(rig, seq, durations)).toBe(60_000);
  });

  test("sample size keeps the aspect, is even, and never upscales", () => {
    expect(sampleDims(3840, 2160, 256)).toEqual({ width: 256, height: 144 });
    expect(sampleDims(1080, 1920, 256)).toEqual({ width: 144, height: 256 });
    expect(sampleDims(100, 50, 256)).toEqual({ width: 100, height: 50 });
  });
});
