// Import the reviewed build-13 score into the existing fixed-clock LBE Introduction.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { encodeShowHeader, parseShow } from "../../../dmx-client/src/shared/show-file";
import { compileRigPatch, rigOrder } from "../model/patch";
import { parseRig } from "../model/rig";
import { newSequence, parseSequence, serializeSequence } from "../model/sequence";

export function alignOnboarding(bytes: Uint8Array): Uint8Array {
  const show = parseShow(bytes, bytes.length), h = show.header;
  if (h.fps !== 40 || h.bits !== 16 || h.pixelCount !== 128 || h.frameCount !== 8426 || h.transfer !== 2.2)
    throw new Error("Expected build-13 eight-tube score: 210.65 s, 40 fps, RGB16, transfer 2.2");
  const raw = bytes.subarray(show.dataOffset), aligned = new Uint8Array(raw.length);
  const bassStart = 6972, delay = 30, stride = show.frameBytes;
  aligned.set(raw.subarray(0, bassStart * stride));
  aligned.set(raw.subarray((bassStart + delay) * stride), bassStart * stride);
  // Keep the quiet final look for the extra 0.75 s of the venue's approved reverb tail.
  for (let i = h.frameCount - delay; i < h.frameCount; i++)
    aligned.set(raw.subarray(raw.length - stride), i * stride);
  return aligned;
}

export function importOnboarding(packageDir: string, rebaked = false) {
  const root = path.resolve(import.meta.dir, "../.."), project = path.join(root, "project/pavotube");
  const rig = parseRig(fs.readFileSync(path.join(project, "rig.json"), "utf8"));
  const source = fs.readFileSync(path.join(packageDir, "native/introduction.show"));
  const digest = createHash("sha256").update(source).digest("hex");
  if (!rebaked && digest !== "dc535671016fed91ad68ad8abd7b8462bf80f8670ce63683436e8c489a362358")
    throw new Error("Source differs from reviewed score v1; review timing before updating this hash");
  const frames = alignOnboarding(source), header = parseShow(source).header;
  header.name = "SoundSpace Introduction · eight PavoTubes (build 13 score)";
  header.experience = "Introduction";
  header.patch = compileRigPatch(rig);
  header.bakedBy = "build-13 score v1; LBE Bass start aligned to 174.3 s";
  const payload = Buffer.concat([encodeShowHeader(header), frames]);
  const seq = newSequence("soundspace-introduction", header.name);
  Object.assign(seq, { experience: "Introduction", sampling: "recorded", bits: 16, fps: 40, level: 1, durationMs: 210650 });
  seq.recorded = {
    description: "Eight-tube score: rain, lightning, purple waveform, ceiling flight and Bass Mosaic. Synced to the venue Introduction; Bass starts at 174.3 s. Retune choreography in scores/onboarding-v1; Level and fixture placement remain editable here.",
    fixtures: rigOrder(rig).map(s => ({ id: s.light.id, count: s.count })),
    showBase64: payload.toString("base64"),
  };
  if (seq.recorded.fixtures.length !== 8 || seq.recorded.fixtures.some(f => f.count !== 16)) throw new Error("Expected eight 16-pixel fixtures");
  // Preview the same black 5.1 video if the local rehearsal has been prepared.
  const screen = path.resolve(root, "../../lbe-client-display/media/introduction-rehearsal/introduction.mp4");
  if (fs.existsSync(screen)) {
    const video = "SoundSpace_Introduction_5.1.mp4";
    fs.copyFileSync(screen, path.join(root, "media", video));
    seq.surfaces = { "intro-screen": { video, gain: 1 } };
  }
  const text = serializeSequence(seq);
  parseSequence(text);
  fs.writeFileSync(path.join(project, "sequences/soundspace-introduction.json"), text);
  for (const folder of ["shows", "media"]) {
    const target = path.resolve(root, `../dmx-client/${folder}/introduction.show`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target + ".tmp", payload); fs.renameSync(target + ".tmp", target);
  }
  const manifest = { source: "https://app.notion.com/p/42369192f39881dc8928c6d8aaecbc0e", sourceSha256: digest,
    sourceBuild: 13, fps: 40, frameCount: 8426, durationMs: 210650, bassStartSeconds: 174.3,
    removedStandaloneDelaySeconds: 0.75, finalFrameHoldSeconds: 0.75,
    sourceTiming: "fixed 17 s reveal, matching the server-owned Unity Timeline",
    outputSha256: createHash("sha256").update(payload).digest("hex"),
    loops: "ambient.show and vr-idle.show retained in source package; not mapped to venue journey states" };
  fs.writeFileSync(path.join(project, "onboarding-score.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: bun src/tools/import-onboarding.ts /path/to/SoundSpace-LBE-EightTube-DMX-v1");
  console.log(JSON.stringify(importOnboarding(path.resolve(process.argv[2]), process.argv.includes("--rebaked")), null, 2));
}
