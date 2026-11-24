import { afterEach, expect, test } from "bun:test";
import { addTube } from "../src/model/ops";
import { newRig } from "../src/model/rig";
import { newSequence } from "../src/model/sequence";
import { togglePlayback } from "../src/web/playback";
import { preview } from "../src/web/preview";
import { getUi, rigStore, setUi } from "../src/web/state";

afterEach(() => {
  preview.pause();
  preview.identify(rigStore.get(), null);
  setUi({ identify: false, walk: false, selection: [], liveOutput: false });
});

function setup() {
  const rig = newRig();
  const tube = addTube(rig);
  const sequence = newSequence("playback", "Playback");
  sequence.durationMs = 1000;
  rigStore.load(rig);
  preview.setDocs(rig, sequence);
  return { rig, tube };
}

test("Identify pauses playback and Play resumes the sequence without losing selection", () => {
  const { rig, tube } = setup();
  preview.seek(250);
  togglePlayback();
  expect(preview.snapshot.playing).toBe(true);
  setUi({ selection: [tube], identify: true, liveOutput: true });
  preview.identify(rig, [tube]);
  expect(preview.snapshot.playing).toBe(false);
  togglePlayback();
  expect(preview.snapshot.playing).toBe(true);
  expect(preview.snapshot.timeMs).toBe(250);
  expect(getUi().identify).toBe(false);
  expect(getUi().selection).toEqual([tube]);
  expect(getUi().liveOutput).toBe(true);
  togglePlayback();
  expect(preview.snapshot.playing).toBe(false);
});

test("Play exits Walk without enabling hardware output when Live is off", () => {
  const { rig, tube } = setup();
  setUi({ selection: [tube], identify: true, walk: true, liveOutput: false });
  preview.identify(rig, [tube]);
  togglePlayback();
  expect(preview.snapshot.playing).toBe(true);
  expect(getUi().identify).toBe(false);
  expect(getUi().walk).toBe(false);
  expect(getUi().liveOutput).toBe(false);
});
