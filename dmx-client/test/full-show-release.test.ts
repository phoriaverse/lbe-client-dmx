import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import manifest from "../../scores/full-show-v1.1/manifest.json";
import { fullShowReleaseDir, loadFullShowRelease, installFullShowScores, installReviewedFile, sha256 } from "../../scripts/full-show-release";
import { parseShow, frameView } from "../src/shared/show-file";
import { validatePatch } from "../src/shared/patch";
import { enttecPatchProblems, PreviewTransport } from "../src/transport";
import { Output } from "../src/output";
import { ShowLibrary } from "../src/shows";

for (const record of manifest.shows) test(`reviewed ${record.state}: every frame matches the delivered DMX output`, () => {
  const bytes = fs.readFileSync(path.join(fullShowReleaseDir, record.file));
  const show = parseShow(bytes, bytes.length), h = show.header;
  expect(sha256(bytes)).toBe(record.sha256);
  expect(validatePatch(h.patch)).toEqual([]);
  expect(enttecPatchProblems(h.patch, 1)).toEqual([]);
  expect(() => parseShow(bytes, bytes.length - 1)).toThrow("truncated");
  expect(h.patch.runs.map(r => r.channel)).toEqual([1, 49, 97, 145, 193, 241, 289, 337]);
  const expected = fs.readFileSync(path.join(fullShowReleaseDir, record.preview));
  const rendered = Buffer.alloc(h.frameCount * 384);
  let sent = new Uint8Array(512), wrongDestination = false, unusedNonzero = false;
  const output = new Output(Object.assign(new PreviewTransport(1), {
    sendUniverse(host: string, _port: number, universe: number, data: Uint8Array) {
      wrongDestination ||= host !== "enttec-usb" || universe !== 1;
      unusedNonzero ||= data.subarray(384).some(v => v !== 0);
      sent = new Uint8Array(data);
    },
  }));
  output.setPatch(h.patch);
  output.setLevels({ master: 1, cap: 0.5 });
  let peak = 0, step = 0;
  for (let frame = 0; frame < h.frameCount; frame++) {
    output.render(frameView(bytes, show, frame), h.transfer);
    rendered.set(sent.subarray(0, 384), frame * 384);
    for (let channel = 0; channel < 384; channel++) {
      peak = Math.max(peak, sent[channel]!);
      if (frame) step = Math.max(step, Math.abs(sent[channel]! - rendered[(frame - 1) * 384 + channel]!));
    }
  }
  expect(wrongDestination || unusedNonzero).toBe(false);
  expect(rendered.equals(expected)).toBe(true);
  expect(peak).toBe(record.peakDmxAt50PercentCap);
  expect(step).toBeLessThanOrEqual(record.state === "Onboarding" ? 1 : 7);
  expect(rendered.subarray(0, 384).every(v => v === 0)).toBe(true);
  expect(rendered.subarray(-384).every(v => v === 0)).toBe(true);
  output.render(null);
  expect(sent.every(v => v === 0)).toBe(true);
});

test("install resolves all server state names, preserves other shows and keeps recoverable backups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lbe-full-show-"));
  try {
    const media = path.join(root, "media"), backups = path.join(root, "backups");
    fs.mkdirSync(media);
    for (const name of ["introduction.show", "Seating.show", "ambient.show"]) fs.writeFileSync(path.join(media, name), name);
    fs.writeFileSync(path.join(media, "onboarding.show"), "previous onboarding");
    const release = loadFullShowRelease();
    installFullShowScores(release, media, backups);
    const library = new ShowLibrary(media);
    library.scan();
    for (const show of release.shows) {
      const entry = library.find(show.state);
      expect(entry).not.toBeNull();
      expect(sha256(fs.readFileSync(entry!.path))).toBe(show.sha256);
    }
    for (const name of ["introduction.show", "Seating.show", "ambient.show"]) expect(fs.readFileSync(path.join(media, name), "utf8")).toBe(name);
    expect(fs.readdirSync(backups)).toHaveLength(1);
    expect(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0]!), "utf8")).toBe("previous onboarding");
    const mtime = fs.statSync(path.join(media, "onboarding.show")).mtimeMs;
    installFullShowScores(release, media, backups);
    expect(fs.statSync(path.join(media, "onboarding.show")).mtimeMs).toBe(mtime);
    // A re-install after rollback can reuse the same verified backup.
    fs.writeFileSync(path.join(media, "onboarding.show"), "previous onboarding");
    installFullShowScores(release, media, backups);
    expect(fs.readdirSync(backups)).toHaveLength(1);
    const target = path.join(media, "Onboarding.mp4");
    expect(() => installReviewedFile(release.onboarding.source, target, "wrong hash", backups)).toThrow("Source changed");
    expect(fs.existsSync(target)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
