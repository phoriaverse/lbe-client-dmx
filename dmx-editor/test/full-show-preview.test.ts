import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { dmxRoot, loadFullShowRelease, sha256 } from "../../scripts/full-show-release";
import { frameView, parseShow } from "../../dmx-client/src/shared/show-file";
import { buildPlan, evaluateFrame } from "../src/model/evaluate";
import { encodeFrame } from "../src/model/pixels";
import { parseRig } from "../src/model/rig";
import { previewSequence } from "../src/tools/import-full-show";

const rig = parseRig(fs.readFileSync(path.join(dmxRoot, "dmx-editor/project/pavotube/rig.json"), "utf8"));
for (const source of loadFullShowRelease().shows) {
  test(`${source.state}: simulator preserves native pixels, timing and scrubbing without a video`, () => {
    const bytes = fs.readFileSync(source.source), show = parseShow(bytes);
    const seq = previewSequence(source.state, bytes, rig);
    expect(sha256(Buffer.from(seq.recorded!.showBase64, "base64"))).toBe(source.sha256);
    expect(seq.durationMs).toBe(source.durationMs);
    const plan = buildPlan(rig, seq);
    // Seek forwards and backwards, including the dark endpoints, without a screen/media decoder.
    for (const fraction of [0, .5, .9, .1, .75, .25, 1]) {
      const index = Math.floor((show.header.frameCount - 1) * fraction);
      const frame = evaluateFrame(plan, () => null, undefined, index * 25);
      const encoded = encodeFrame(frame, 16);
      const original = frameView(bytes, show, index);
      if (!(original instanceof Uint16Array)) throw new Error("Expected RGB16 score");
      expect(new Uint16Array(encoded.buffer)).toEqual(original);
    }
    expect(evaluateFrame(plan, () => null, undefined, source.durationMs).every(x => x === 0)).toBe(true);
  });
}
