// bun run create:introduction [--quest ../../lbe-client-quest]
// Generates an editor guide, a full-length unison track and its journey .show. No output hardware.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { bake } from "../bake/bake";
import { findTool } from "../bake/media";
import { parseRig } from "../model/rig";
import { parseSequence, serializeSequence } from "../model/sequence";
import { introductionIntensities, mixCue, readIntroduction } from "./introduction";
import { guideLabel } from "./guide-label";

const root = path.resolve(import.meta.dir, "../..");
const argument = process.argv.indexOf("--quest");
const quest = path.resolve(argument >= 0 ? process.argv[argument + 1]! : path.join(root, "../../lbe-client-quest"));
const source = path.join(quest, "Assets/Project/Introduction");
const project = path.join(root, "project/pavotube");
const existing = path.join(project, "sequences/soundspace-introduction.json");
if (fs.existsSync(existing) && parseSequence(fs.readFileSync(existing, "utf8")).sampling === "recorded")
  throw new Error("The Introduction uses the reviewed eight-tube score. Bake it in the editor; this older unison generator would overwrite its choreography.");
const media = path.join(root, "media");
const ffmpeg = findTool("ffmpeg");
if (!ffmpeg) throw new Error("ffmpeg is required to analyse the bundled audio and make the preview guide");
const rate = 16000, fps = 40, videoFps = 20, side = 192;
const video = "SoundSpace_Introduction_Lighting_Guide.mp4";
const sourceNames = ["Sequence/Introduction.playable", "Sequence/Introduction.anim", "Introduction.unity"];
const texts = sourceNames.map(name => fs.readFileSync(path.join(source, name), "utf8"));
const intro = readIntroduction(texts[0]!, texts[1]!, texts[2]!);
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const audioFiles = new Map<string, string>();
for (const name of fs.readdirSync(path.join(source, "Audio")).filter(n => n.endsWith(".meta"))) {
  const file = path.join(source, "Audio", name);
  const guid = fs.readFileSync(file, "utf8").match(/^guid: (\w+)/m)?.[1];
  if (guid) audioFiles.set(guid, file.slice(0, -5));
}
const decoded = new Map<string, Float32Array>();
const samples = Math.round(intro.duration * rate);
const guide = new Float32Array(samples);
const buses = { music: new Float32Array(samples), rain: new Float32Array(samples), thunder: new Float32Array(samples) };
const inputs: Record<string, string> = {};
for (const cue of intro.audio) {
  const file = audioFiles.get(cue.guid);
  if (!file || !fs.existsSync(file)) throw new Error(`Missing audio for ${cue.name}; run git lfs pull in the Quest repo`);
  if (!decoded.has(cue.guid)) {
    const process = Bun.spawn([ffmpeg, "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { stdout: "pipe", stderr: "pipe" });
    const [bytes, error, exit] = await Promise.all([new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text(), process.exited]);
    if (exit) throw new Error(error);
    decoded.set(cue.guid, new Float32Array(bytes));
    inputs[path.relative(quest, file)] = hash(fs.readFileSync(file));
  }
  const audio = decoded.get(cue.guid)!;
  mixCue(guide, audio, cue, rate);
  if (["Order from Chaos", "Bass Mosaic"].includes(cue.name)) mixCue(buses.music, audio, cue, rate);
  if (cue.name === "Rain objects") mixCue(buses.rain, audio, cue, rate);
  if (cue.name.startsWith("Thunder")) mixCue(buses.thunder, audio, cue, rate);
}
const intensities = introductionIntensities(intro, buses, rate, fps);
let peak = 0;
for (const sample of guide) peak = Math.max(peak, Math.abs(sample));
// Guide-only mono mix: keep headroom. The Quest continues to own its authored spatial soundtrack.
const guideGain = peak ? Math.min(1, 0.85 / peak) : 1;
for (let i = 0; i < guide.length; i++) guide[i]! *= guideGain;
const rehearsalPath = path.join(project, "sequences/intro-lissajous.json");
const rehearsalBytes = fs.readFileSync(rehearsalPath);
const rehearsal = parseSequence(rehearsalBytes.toString());
const sequence = structuredClone(rehearsal);
sequence.id = "soundspace-introduction";
sequence.name = "SoundSpace Introduction · full timeline";
sequence.experience = "Introduction";
sequence.durationMs = intro.duration * 1000;
sequence.fps = fps;
sequence.sampleSize = 32;
sequence.sampling = "unison";
sequence.level = 0.35;
sequence.bits = 8;
sequence.surfaces = { "intro-screen": { video, gain: 1 } };
sequence.unison = { video, source: "lbe-client-quest/Assets/Project/Introduction/Sequence/Introduction.playable",
  sourceStartMs: 0, color: [144, 2, 255], fps, intensities,
  description: "Full Quest Introduction: Timeline audio energy plus authored rain, steam, waveform, ceiling and aurora cues. Same purple on all tubes; 80 ms attack / 250 ms release; 2 s fade-in / 1.5 s fade-out. Guide audio is mono and the screen is a lighting reference, not a Quest render or Dolby mix." };
parseSequence(serializeSequence(sequence));

fs.mkdirSync(media, { recursive: true });
const rawAudio = path.join(media, `.introduction-guide-${process.pid}.f32`);
const temporaryVideo = path.join(media, `.introduction-guide-${process.pid}.mp4`);
fs.writeFileSync(rawAudio, Buffer.from(guide.buffer));
const bass = intro.audio.find(c => c.name === "Bass Mosaic")!.start;
const waveform = intro.curves["Waveform/m_IsActive"]!.find(k => k.value === 1)!.time;
const ceiling = intro.audio.find(c => c.name === "Ceiling swell")!.start;
const aurora = intro.audio.find(c => c.name === "Aurora keys")!.start;
const phases = [{ time: 0, name: "Rain and steam" }, { time: waveform, name: "Waveform" },
  { time: ceiling, name: "Ceiling reveal" }, { time: aurora, name: "Room reveal" }, { time: bass, name: "Bass Mosaic" }];
console.log(`Authoring ${intro.duration}s, ${intensities.length} lighting frames; making guide video…`);
try {
  const encoder = Bun.spawn([ffmpeg, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${side}x${side}`, "-r", String(videoFps), "-i", "pipe:0",
    "-f", "f32le", "-ar", String(rate), "-ac", "1", "-i", rawAudio, "-vf", "scale=720:720:flags=neighbor",
    "-t", String(intro.duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", temporaryVideo],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  const error = new Response(encoder.stderr).text();
  try {
    for (let f = 0; f < Math.ceil(intro.duration * videoFps); f++) {
      const brightness = Math.pow(intensities[Math.min(intensities.length - 1, Math.round(f * fps / videoFps))]!, 1 / 2.2);
      const frame = new Uint8Array(side * side * 3);
      for (let y = 35; y < 141; y++) for (let x = 18; x < side - 18; x++) {
        const k = ((x - 18) % 20 < 10) ? brightness : brightness * 0.06;
        const offset = (y * side + x) * 3;
        frame[offset] = Math.round(144 * k); frame[offset + 1] = Math.round(2 * k); frame[offset + 2] = Math.round(255 * k);
      }
      for (let x = 18; x < 18 + (side - 36) * f / (intro.duration * videoFps); x++)
        frame.set([180, 180, 180], (151 * side + x) * 3);
      const time = f / videoFps;
      guideLabel(frame, side, "SOUNDSPACE INTRODUCTION", 5);
      guideLabel(frame, side, "LIGHTING TIMING GUIDE", 18, 160);
      guideLabel(frame, side, phases.findLast(phase => phase.time <= time)!.name, 159);
      guideLabel(frame, side, `${String(Math.floor(time / 60)).padStart(2, "0")}:${(time % 60).toFixed(1).padStart(4, "0")}`, 171);
      guideLabel(frame, side, "MONO GUIDE - NOT SHOW AUDIO", 183, 150);
      encoder.stdin.write(frame);
      await encoder.stdin.flush();
    }
    await encoder.stdin.end();
    if (await encoder.exited) throw new Error(await error);
  } catch (cause) {
    encoder.kill();
    await encoder.exited;
    throw new Error(`${cause}\n${await error}`);
  }
  fs.renameSync(temporaryVideo, path.join(media, video));
} finally {
  fs.rmSync(rawAudio, { force: true });
  fs.rmSync(temporaryVideo, { force: true });
}
fs.writeFileSync(path.join(project, "sequences", `${sequence.id}.json`), serializeSequence(sequence));
const revision = Bun.spawnSync(["git", "-C", quest, "rev-parse", "HEAD"]).stdout.toString().trim();
const provenance = { sourceRepository: "phoriaverse/lbe-client-quest", sourceCommit: revision,
  sourceHashes: { ...Object.fromEntries(sourceNames.map((name, i) => [`Assets/Project/Introduction/${name}`, hash(texts[i]!)])), ...inputs },
  durationMs: sequence.durationMs, fps, frameCount: intensities.length, phases, audio: intro.audio,
  guide: { file: video, description: "Mono analysis mix and lighting visualisation; not a Quest render or Dolby re-render", gain: guideGain },
  lighting: { color: sequence.unison.color, level: sequence.level, attackMs: 80, releaseMs: 250, fadeInMs: 2000, fadeOutMs: 1500 },
  rehearsal: { file: "sequences/intro-lissajous.json", sha256: hash(rehearsalBytes), durationMs: rehearsal.durationMs } };
fs.writeFileSync(path.join(project, "introduction-timing.json"), JSON.stringify(provenance, null, 2) + "\n");
const rig = parseRig(fs.readFileSync(path.join(project, "rig.json"), "utf8"));
const result = await bake({ rig, sequence });
const deployed = path.join(root, "../dmx-client/media/introduction.show");
fs.mkdirSync(path.dirname(deployed), { recursive: true });
fs.copyFileSync(result.file, deployed + ".tmp");
fs.renameSync(deployed + ".tmp", deployed);
if (!fs.readFileSync(rehearsalPath).equals(rehearsalBytes)) throw new Error("Rehearsal preset changed during generation");
console.log(JSON.stringify({ ...result, deployed, guide: path.join(media, video) }, null, 2));
