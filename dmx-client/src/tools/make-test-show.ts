// `bun run make-test-show` — bake a synthetic .show without the editor.
//
// It exists to prove the half of the system the editor is not needed for: the file format, the
// library's name matching, the Ready barrier, the clock-synced start and the server-owned close.
// The look is designed to be read by eye against a clock:
//
//   · every whole second, the entire rig flashes white for 100ms  → is the start on the beat?
//   · a bar fills along the chain over the show's length          → is it tracking, start to end?
//   · a slow hue drift underneath                                  → is it alive between flashes?
//
//   bun run make-test-show                              # "Test A", 64.5s — the LBE's test experience
//   bun run make-test-show -- --experience "Second Nature" --seconds 195.767
//   bun run make-test-show -- --ambient                 # a dim idle loop, played between sessions
//   bun run make-test-show -- --bits 16 --fps 50
//
// The patch comes from config.json's rig, so it lands on whatever this machine is set up to drive.

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import { AMBIENT_EXPERIENCE, SHOW_EXTENSION, SHOW_TRANSFER, SHOW_VERSION, type SampleBits, type ShowHeader, encodeSample, encodeShowHeader, slugOf } from "../shared/show-file";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const config = loadConfig();
if (!config.patch) {
  console.error("config.json has no rig to bake a test show for.");
  process.exit(1);
}

const ambient = process.argv.includes("--ambient");
const experience = ambient ? AMBIENT_EXPERIENCE : (arg("experience") ?? "Test A");
const seconds = Number(arg("seconds") ?? (ambient ? 20 : 64.5));
const fps = Number(arg("fps") ?? 40);
const bits = Number(arg("bits") ?? 8) as SampleBits;
const level = Number(arg("level") ?? 0.35); // linear-light peak; modest on purpose

const patch = config.patch;
const pixels = patch.pixelCount;
const frameCount = Math.round(seconds * fps);

const header: ShowHeader = {
  version: SHOW_VERSION,
  name: ambient ? "Test ambient" : `Test pattern for ${experience}`,
  experience,
  fps,
  bits,
  pixelCount: pixels,
  frameCount,
  transfer: SHOW_TRANSFER,
  patch,
  bakedAt: new Date().toISOString(),
  bakedBy: "make-test-show",
};
if (ambient) header.loop = true;

const headerBytes = encodeShowHeader(header);
const bytesPerSample = bits / 8;
const out = new Uint8Array(headerBytes.length + frameCount * pixels * 3 * bytesPerSample);
out.set(headerBytes, 0);
const view = new DataView(out.buffer);

const put = (frame: number, pixel: number, r: number, g: number, b: number) => {
  const base = headerBytes.length + (frame * pixels + pixel) * 3 * bytesPerSample;
  const rgb = [r, g, b];
  for (let c = 0; c < 3; c++) {
    const sample = encodeSample(rgb[c]!, bits);
    if (bits === 16) view.setUint16(base + c * 2, sample, true);
    else out[base + c] = sample;
  }
};

/** A soft hue wheel in linear light. */
const hue = (h: number): [number, number, number] => {
  const a = h * Math.PI * 2;
  return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.cos(a - 2.094), 0.5 + 0.5 * Math.cos(a + 2.094)];
};

for (let f = 0; f < frameCount; f++) {
  const t = f / fps;
  if (ambient) {
    // Seamless: every term is periodic over the loop length.
    for (let p = 0; p < pixels; p++) {
      const phase = (t / seconds) * Math.PI * 2;
      const wave = 0.5 + 0.5 * Math.sin(phase + (p / pixels) * Math.PI * 4);
      const [r, g, b] = hue(t / seconds + p / pixels);
      const v = level * 0.25 * wave;
      put(f, p, r * v, g * v, b * v);
    }
    continue;
  }

  const flash = t % 1 < 0.1;
  const filled = Math.floor((t / seconds) * pixels);
  for (let p = 0; p < pixels; p++) {
    if (flash) {
      put(f, p, level, level, level);
      continue;
    }
    const [r, g, b] = hue(t / 20 + p / pixels);
    const v = p <= filled ? level * 0.5 : level * 0.04;
    put(f, p, r * v, g * v, b * v);
  }
}

fs.mkdirSync(config.showsDir, { recursive: true });
const file = path.join(config.showsDir, `${slugOf(experience)}${SHOW_EXTENSION}`);
// Write beside, then rename: a client that is mid-scan (or mid-show) must never map a half-written file.
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, out);
fs.renameSync(tmp, file);
console.log(`wrote ${path.relative(process.cwd(), file)} — "${experience}", ${seconds}s, ${frameCount} frames @ ${fps}fps ${bits}-bit, ${pixels} px, ${(out.length / 1e6).toFixed(1)} MB`);
