// Install the reviewed native scores without rebaking or changing the Introduction.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import manifest from "../scores/full-show-v1.1/manifest.json";
import { parseShow, durationMsOf } from "../dmx-client/src/shared/show-file";
import { enttecPatchProblems } from "../dmx-client/src/transport";
import { compileRigPatch } from "../dmx-editor/src/model/patch";
import { parseRig } from "../dmx-editor/src/model/rig";
import type { Patch } from "../dmx-client/src/shared/patch";

export const dmxRoot = path.resolve(import.meta.dir, "..");
export const fullShowReleaseDir = path.join(dmxRoot, "scores/full-show-v1.1");
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const patchContract = (patch: Patch) => ({
  pixelCount: patch.pixelCount,
  gateways: patch.gateways.map(({ id, host, port }) => ({ id, host, port: port ?? 6454 })),
  runs: patch.runs,
});

export function loadFullShowRelease() {
  const rig = parseRig(fs.readFileSync(path.join(dmxRoot, "dmx-editor/project/pavotube/rig.json"), "utf8"));
  const patch = patchContract(compileRigPatch(rig));
  const states = ["Onboarding", "Second Nature", "The Shape of Memory", "Sit Around The Fire"];
  const shows = states.map(state => {
    const records = manifest.shows.filter(s => s.state.toLowerCase() === state.toLowerCase());
    if (records.length !== 1) throw new Error(`Expected one reviewed score for ${state}`);
    const record = records[0]!;
    const source = path.join(fullShowReleaseDir, record.file), bytes = fs.readFileSync(source);
    if (sha256(bytes) !== record.sha256) throw new Error(`Reviewed score changed: ${record.file}`);
    const show = parseShow(bytes, bytes.length), h = show.header;
    if (bytes.length !== show.dataOffset + show.frameBytes * h.frameCount || h.fps !== 40 || h.bits !== 16 ||
        h.transfer !== 2.2 || h.loop || durationMsOf(h) !== record.duration * 1000)
      throw new Error(`Invalid score format or timing: ${state}`);
    const problems = enttecPatchProblems(h.patch, 1);
    if (problems.length || !isDeepStrictEqual(patchContract(h.patch), patch))
      throw new Error(`The reviewed ${state} patch differs from the venue rig; remap and review before deployment. ${problems.join("; ")}`);
    return { state, file: `${state}.show`, source, sha256: record.sha256, durationMs: durationMsOf(h) };
  });
  const video = manifest.instructionVideo;
  const source = path.join(fullShowReleaseDir, "reference", video.sourceVideo);
  if (sha256(fs.readFileSync(source)) !== video.sourceSha256) throw new Error("The reviewed onboarding video changed");
  return { version: manifest.version, shows, onboarding: {
    source, file: "Onboarding.mp4", sha256: video.sourceSha256, durationMs: video.durationSeconds * 1000,
  } };
}

/** Back up changed files outside the playback folder, then publish each complete file atomically. */
export function installReviewedFile(source: string, target: string, expectedHash: string, backupDir: string) {
  const bytes = fs.readFileSync(source);
  if (sha256(bytes) !== expectedHash) throw new Error(`Source changed before installation: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Avoid two candidates for the same case-insensitive state on case-sensitive volumes.
  const matches = fs.readdirSync(path.dirname(target)).filter(n => n.toLowerCase() === path.basename(target).toLowerCase());
  if (matches.length > 1) throw new Error(`Ambiguous existing media for ${target}`);
  if (matches[0]) target = path.join(path.dirname(target), matches[0]);
  if (fs.existsSync(target)) {
    const previous = fs.readFileSync(target), previousHash = sha256(previous);
    if (previousHash === expectedHash) return target;
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `${path.basename(target)}.${previousHash}.bak`);
    if (fs.existsSync(backup)) {
      if (sha256(fs.readFileSync(backup)) !== previousHash) throw new Error(`Existing backup is damaged: ${backup}`);
    } else fs.writeFileSync(backup, previous, { flag: "wx" });
  }
  const temp = `${target}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, bytes); fs.renameSync(temp, target); }
  finally { fs.rmSync(temp, { force: true }); }
  return target;
}

export function installFullShowScores(release: ReturnType<typeof loadFullShowRelease>, destination: string, backupDir: string) {
  for (const show of release.shows)
    installReviewedFile(show.source, path.join(destination, show.file), show.sha256, backupDir);
}

if (import.meta.main) {
  const release = loadFullShowRelease();
  for (const folder of ["media", "shows"])
    installFullShowScores(release, path.join(dmxRoot, "dmx-client", folder), path.join(dmxRoot, "backups/full-show-v1.1", folder));
  console.log(`Installed ${release.shows.length} reviewed scores (${release.version}); Introduction, Seating and ambient preserved. No hardware opened.`);
}
