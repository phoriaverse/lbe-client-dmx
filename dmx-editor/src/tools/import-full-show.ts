// Expose the reviewed native scores in the simulator without rebaking production files.
import fs from "node:fs";
import path from "node:path";
import { dmxRoot, loadFullShowRelease, installReviewedFile, sha256 } from "../../../scripts/full-show-release";
import { parseShow } from "../../../dmx-client/src/shared/show-file";
import { rigOrder } from "../model/patch";
import { parseRig, type RigDocument } from "../model/rig";
import { newSequence, parseSequence, serializeSequence } from "../model/sequence";

const treatments: Record<string, string> = {
  Onboarding: "Gentle White Waves",
  "Second Nature": "B · Chromatic Rapids",
  "The Shape of Memory": "B · Neural Current",
  "Sit Around The Fire": "B · Rising Embers",
};

export function previewSequence(state: string, bytes: Uint8Array, rig: RigDocument, video?: string) {
  const h = parseShow(bytes, bytes.length).header;
  const id = `full-show-v1-1-${state.toLowerCase().replaceAll(" ", "-")}`;
  const seq = newSequence(id, `${state} · ${treatments[state] ?? "native score"} (v1.1)`);
  Object.assign(seq, { experience: state, sampling: "recorded", bits: h.bits, fps: h.fps,
    level: 1, durationMs: h.frameCount * 1000 / h.fps });
  seq.recorded = {
    description: "Reviewed SoundSpace 1.1 score. Play or scrub to preview the original per-pixel lighting. Music is optional (Sound); Live sends to physical tubes. Choreography source is in scores/full-show-v1.1.",
    fixtures: rigOrder(rig).map(s => ({ id: s.light.id, count: s.count })),
    showBase64: Buffer.from(bytes).toString("base64"),
  };
  if (video) seq.surfaces = { "intro-screen": { video, gain: 1 } };
  return parseSequence(serializeSequence(seq));
}

export function importFullShowPreviews() {
  const release = loadFullShowRelease(); // Validates hashes, timings and the venue patch first.
  const editor = path.join(dmxRoot, "dmx-editor"), project = path.join(editor, "project/pavotube");
  const rig = parseRig(fs.readFileSync(path.join(project, "rig.json"), "utf8"));
  const mediaDir = path.join(editor, "media"), sequenceDir = path.join(project, "sequences");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(sequenceDir, { recursive: true });
  for (const show of release.shows) {
    const source = show.state === "Onboarding" ? release.onboarding.source
      : path.resolve(dmxRoot, "../lbe-client-display/media/full-show", `${show.state}.mp4`);
    const video = fs.existsSync(source) ? `Full_Show_1.1_${show.state.replaceAll(" ", "_")}.mp4` : undefined;
    if (video) {
      const backup = path.join(dmxRoot, "backups/full-show-preview/media");
      if (show.state === "Onboarding") {
        // The venue's editor surface is square. Letterbox the 2:1 caption video so it is
        // not stretched, without changing the shared rig or the original room-player file.
        const tempVideo = path.join(mediaDir, `.onboarding-${process.pid}.mp4`);
        try {
          const result = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", source,
            "-vf", "pad=iw:iw:0:(ow-ih)/2:black,setsar=1", "-an", "-c:v", "libx264",
            "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", tempVideo]);
          if (result.exitCode !== 0) throw new Error(`Cannot prepare square-screen captions: ${result.stderr.toString()}`);
          installReviewedFile(tempVideo, path.join(mediaDir, video), sha256(fs.readFileSync(tempVideo)), backup);
        } finally { fs.rmSync(tempVideo, { force: true }); }
      } else installReviewedFile(source, path.join(mediaDir, video), sha256(fs.readFileSync(source)), backup);
    }
    const seq = previewSequence(show.state, fs.readFileSync(show.source), rig, video);
    const target = path.join(sequenceDir, `${seq.id}.json`);
    // Do not replace edits made in the editor when this command is run again.
    if (fs.existsSync(target)) {
      console.log(`Kept existing preset: ${seq.name}`);
      continue;
    }
    const temp = `${target}.${process.pid}.tmp`;
    try { fs.writeFileSync(temp, serializeSequence(seq)); fs.renameSync(temp, target); }
    finally { fs.rmSync(temp, { force: true }); }
    console.log(`Added: ${seq.name} — ${seq.durationMs! / 1000}s${video ? " + media" : " (lighting only; room media not prepared)"}`);
  }
  console.log("Reload the editor → Sequence → choose a v1.1 preset → Play. Leave Live off for simulation. No .show files changed.");
}

if (import.meta.main) importFullShowPreviews();
