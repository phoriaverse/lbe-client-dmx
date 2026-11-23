import { describe, expect, test } from "bun:test";
import { simplePatch } from "../src/shared/patch";
import { SHOW_TRANSFER, SHOW_VERSION, type ShowHeader, durationMsOf, encodeSample, encodeShowHeader, frameView, parseShow, slugOf } from "../src/shared/show-file";

const header = (over: Partial<ShowHeader> = {}): ShowHeader => ({
  version: SHOW_VERSION,
  name: "t",
  experience: "Test A",
  fps: 40,
  bits: 8,
  pixelCount: 64,
  frameCount: 5,
  transfer: SHOW_TRANSFER,
  patch: simplePatch({ host: "2.0.0.100", fixtures: 2, pixelsPerFixture: 32 }),
  bakedAt: "2026-11-13T00:00:00.000Z",
  ...over,
});

function build(h: ShowHeader, fill: (sampleIndex: number) => number): Uint8Array {
  const head = encodeShowHeader(h);
  const samples = h.frameCount * h.pixelCount * 3;
  const out = new Uint8Array(head.length + samples * (h.bits / 8));
  out.set(head);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    if (h.bits === 16) view.setUint16(head.length + i * 2, fill(i), true);
    else out[head.length + i] = fill(i);
  }
  return out;
}

describe(".show format", () => {
  test("round-trips the header and puts frame data on an 8-byte boundary", () => {
    const bytes = build(header(), (i) => i % 251);
    const show = parseShow(bytes, bytes.length);
    expect(show.header.experience).toBe("Test A");
    expect(show.header.patch.runs.length).toBe(2);
    expect(show.dataOffset % 8).toBe(0);
    expect(show.frameBytes).toBe(64 * 3);
    expect(durationMsOf(show.header)).toBe(125);
  });

  test("8-bit frames come back sample for sample", () => {
    const bytes = build(header(), (i) => i % 251);
    const show = parseShow(bytes, bytes.length);
    const f2 = frameView(bytes, show, 2);
    expect(f2).toBeInstanceOf(Uint8Array);
    expect(f2.length).toBe(192);
    expect(f2[0]).toBe((2 * 192) % 251);
    expect(f2[191]).toBe((2 * 192 + 191) % 251);
  });

  test("16-bit frames are little-endian and viewable in place", () => {
    const h = header({ bits: 16 });
    const bytes = build(h, (i) => (i * 257) % 65536);
    const show = parseShow(bytes, bytes.length);
    const f1 = frameView(bytes, show, 1);
    expect(f1).toBeInstanceOf(Uint16Array);
    expect(f1.length).toBe(192);
    expect(f1[3]).toBe(((192 + 3) * 257) % 65536);
    expect(f1.buffer).toBe(bytes.buffer); // a view, not a copy
  });

  test("a truncated file is refused, not half-played", () => {
    const bytes = build(header(), () => 0);
    expect(() => parseShow(bytes, bytes.length - 1)).toThrow("truncated");
    expect(() => parseShow(bytes.subarray(0, 20))).toThrow();
  });

  test("garbage, wrong versions and mismatched patches are refused", () => {
    expect(() => parseShow(new Uint8Array(64))).toThrow("bad magic");
    expect(() => encodeShowHeader(header({ version: 2 }))).toThrow("version");
    expect(() => encodeShowHeader(header({ pixelCount: 32 }))).toThrow("patch is for 64");
    expect(() => encodeShowHeader(header({ bits: 12 as 8 }))).toThrow("bits");
  });

  test("samples are perceptually spaced: half the codes sit below ~22% light", () => {
    expect(encodeSample(0, 8)).toBe(0);
    expect(encodeSample(1, 8)).toBe(255);
    expect(encodeSample(2, 8)).toBe(255);
    expect(encodeSample(-1, 8)).toBe(0);
    expect(encodeSample(Math.pow(0.5, 2.2), 8)).toBe(128);
    expect(encodeSample(Math.pow(0.5, 2.2), 16)).toBe(32768);
  });

  test("experience names compare by slug", () => {
    expect(slugOf("Second Nature")).toBe("second-nature");
    expect(slugOf("  second_nature ")).toBe("second-nature");
    expect(slugOf("Sit Around The Fire")).toBe(slugOf("sit-around-the-fire"));
  });
});
