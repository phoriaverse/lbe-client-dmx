// First-pass authoring for Phill's intro. Run after making the square copy trimmed at 18 seconds.
// bun src/tools/create-lissajous.ts (from dmx-editor/). No hardware is opened here.
import path from "node:path";
import { ffmpegDecoder, findTool, probeVideo } from "../bake/media";
import { parseRig, serializeRig, defaultSurface } from "../model/rig";
import { newSequence, parseSequence, serializeSequence } from "../model/sequence";

const root = path.resolve(import.meta.dir, "../..");
const video = "Lisajous_Curve_2_From18s_Square_5.1.mp4";
const file = path.join(root, "media", video);
const info = await probeVideo(file);
const fps = 40, size = 96, audioRate = 16000;
const count = Math.round(info.durationMs * fps / 1000);
const audioProc = Bun.spawn([findTool("ffmpeg")!, "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(audioRate), "-f", "f32le", "-"], { stdout: "pipe", stderr: "pipe" });
const [audioBytes, audioError, audioExit] = await Promise.all([new Response(audioProc.stdout).arrayBuffer(), new Response(audioProc.stderr).text(), audioProc.exited]);
if (audioExit) throw new Error(audioError);
const audio = new Float32Array(audioBytes);
const decoder = ffmpegDecoder(file, { fps, width: size, height: size });
const water: number[] = [], curve: number[] = [], rms: number[] = [];
const colour = [0, 0, 0];
let colourWeight = 0;
const linear = (v: number) => v <= 10 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4);
try {
  for (let f = 0; f < count; f++) {
    const pic = await decoder.next();
    let w = 0, c = 0, nw = 0, nc = 0;
    if (pic) for (let y = 19; y < 91; y++) for (let x = 14; x < 82; x++) {
      const i = (y * size + x) * 3;
      const r = pic.data[i]!, g = pic.data[i + 1]!, b = pic.data[i + 2]!;
      const bright = Math.max(linear(r), linear(g), linear(b));
      if (y >= 58) { w += bright; nw++; } else { c += bright; nc++; }
      // Sample the saturated purple water in the first half, before the later scene transition.
      if (f < 15 * fps && y >= 58 && b > 100 && r > 40 && g < r * 0.5 && b > r * 1.15) {
        const weight = bright;
        colour[0]! += r * weight; colour[1]! += g * weight; colour[2]! += b * weight;
        colourWeight += weight;
      }
    }
    water.push(nw ? w / nw : 0); curve.push(nc ? c / nc : 0);
    const start = Math.round(f * audioRate / fps), end = Math.min(audio.length, Math.round((f + 1) * audioRate / fps));
    let energy = 0;
    for (let i = start; i < end; i++) energy += audio[i]! ** 2;
    rms.push(end > start ? Math.sqrt(energy / (end - start)) : 0);
  }
} finally { decoder.close(); }
const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]!;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const wp = Math.max(1e-6, percentile(water, 0.95)), cp = Math.max(1e-6, percentile(curve, 0.95));
const ap = Math.max(1e-6, percentile(rms, 0.95));
// Preserve the sampled purple hue at full chroma brightness. Overall level lives in the sequence.
const peak = Math.max(...colour);
if (!colourWeight || !peak) throw new Error("No purple water pixels found");
const rgb = colour.map((v) => Math.round(v / peak * 255)) as [number, number, number];
let smoothed = 0;
const intensities = water.map((w, f) => {
  const visual = clamp(0.72 * clamp(w / wp) + 0.28 * clamp(curve[f]! / cp));
  const sound = Math.sqrt(clamp(rms[f]! / ap));
  const target = visual * (0.25 + 0.75 * sound);
  const tau = target > smoothed ? 0.04 : 0.18;
  smoothed += (target - smoothed) * (1 - Math.exp(-1 / fps / tau));
  const fadeIn = clamp(f / fps / 0.15), fadeOut = clamp((count - 1 - f) / fps / 0.5);
  return Number((smoothed * fadeIn * fadeOut).toFixed(5));
});

const rigFile = path.join(root, "project/pavotube/rig.json");
const rig = parseRig(await Bun.file(rigFile).text());
const screenId = "intro-screen";
if (!rig.nodes.some((node) => node.id === screenId)) rig.nodes.push({
  id: screenId, name: "Intro screen · square", parent: null,
  transform: { position: [8.853, 1.629, 0.84], rotation: [0, 0, 0], scale: [1, 1, 1] },
  surface: { ...defaultSurface(), width: 2.86, height: 2.86 },
});
const seq = newSequence("intro-lissajous", "Intro Lissajous · from 18s");
seq.experience = "Intro Lissajous";
seq.fps = fps;
seq.level = 0.35;
seq.durationMs = count * 1000 / fps;
seq.sampling = "unison";
seq.surfaces[screenId] = { video, gain: 1 };
seq.unison = {
  video, source: "Lisajous_Curve_2.mp4", sourceStartMs: 18000, color: rgb, fps, intensities,
  description: "Purple sampled from the water; intensity follows water/curve brightness and the soundtrack, with softened attacks and fades.",
};
parseSequence(serializeSequence(seq));
await Bun.write(rigFile, serializeRig(rig));
await Bun.write(path.join(root, "project/pavotube/sequences/intro-lissajous.json"), serializeSequence(seq));
console.log(JSON.stringify({ durationSeconds: count / fps, frames: count, color: rgb, colorHex: `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`, min: Math.min(...intensities), max: Math.max(...intensities), checkpoints: Array.from({ length: 8 }, (_, i) => ({ at: i * 5, intensity: intensities[i * 5 * fps], audioRms: rms[i * 5 * fps] })) }, null, 2));
