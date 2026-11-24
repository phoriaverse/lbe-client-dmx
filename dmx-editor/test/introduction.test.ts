import { expect, test } from "bun:test";
import { cueGain, curveAt, introductionIntensities, mixCue, readIntroduction, type AudioCue, type Introduction } from "../src/tools/introduction";

const cue: AudioCue = { name: "Test", guid: "audio", start: 0.5, duration: 0.5, clipIn: 0,
  fadeIn: 0, fadeOut: 0, gain: 0.5, loop: true };
const key = (time: number, value: number, slope = 0) => ({ time, value, inSlope: slope, outSlope: slope });
const names = ["Steam/material._Density", "Waveform/m_IsActive", "Rain/m_IsActive", "Ceiling pulse/material._GlobalAlpha", "RingAurora_2/material._GeneralAlpha"];

test("Unity audio bindings retain 64-bit fileIDs, cue times and scene gains", () => {
  const timeline = ["--- !u!114 &1\nMonoBehaviour:\n  m_EditorClassIdentifier: Unity.Timeline::UnityEngine.Timeline.TimelineAsset\n  m_FixedDuration: 4"];
  const bindings: string[] = [];
  const sources: string[] = [];
  for (const [i, name] of ["Order from Chaos", "Bass Mosaic", "Ceiling swell", "Rain objects"].entries()) {
    const track = String(9007199254740992n + BigInt(i)), asset = String(-9007199254740999n - BigInt(i));
    timeline.push(`--- !u!114 &${track}\nMonoBehaviour:\n  m_Name: ${name}\n  m_EditorClassIdentifier: UnityEngine.Timeline.AudioTrack\n  m_Muted: 0\n  m_TrackProperties: {volume: 0.5}\n  m_Clips:\n  - m_Start: ${i}\n    m_Duration: 1\n    m_ClipIn: 0\n    m_TimeScale: 1\n    m_EaseInDuration: 0\n    m_EaseOutDuration: 0\n    m_Asset: {fileID: ${asset}}`);
    timeline.push(`--- !u!114 &${asset}\nMonoBehaviour:\n  m_Clip: {guid: audio${i}}\n  m_Loop: 0\n  m_ClipProperties: {volume: 0.5}`);
    bindings.push(`  - key: {fileID: ${track}}\n    value: {fileID: ${i + 10}}`);
    sources.push(`--- !u!82 &${i + 10}\nAudioSource:\n  m_Volume: 0.4\n  Mute: 0`);
  }
  const scene = `--- !u!320 &9\nPlayableDirector:\n  m_SceneBindings:\n${bindings.join("\n")}\n${sources.join("\n")}`;
  const curves = names.map(name => {
    const slash = name.indexOf("/");
    return `  - path: ${name.slice(0, slash)}\n    attribute: ${name.slice(slash + 1)}\n    curve:\n      m_Curve:\n      - {time: 0, value: 1, inSlope: 0, outSlope: 0, weightedMode: 0}`;
  });
  const animation = `--- !u!74 &74\nAnimationClip:\n  m_FloatCurves:\n${curves.join("\n")}`;
  const parsed = readIntroduction(timeline.join("\n"), animation, scene);
  expect(parsed.duration).toBe(4);
  expect(parsed.audio.map(c => [c.name, c.start, c.gain, c.guid])).toEqual([
    ["Order from Chaos", 0, 0.1, "audio0"], ["Bass Mosaic", 1, 0.1, "audio1"],
    ["Ceiling swell", 2, 0.1, "audio2"], ["Rain objects", 3, 0.1, "audio3"],
  ]);
  expect(() => readIntroduction(timeline.join("\n").replace("m_TimeScale: 1", "m_TimeScale: 2"), animation, scene)).toThrow("Unsupported");
});

test("authored Hermite and step curves evaluate by absolute Timeline time", () => {
  expect(curveAt([key(0, 0), key(1, 1)], 0.25)).toBeCloseTo(0.15625);
  const stepped = [key(0, 0, Infinity), key(42.64, 1, Infinity)];
  expect(curveAt(stepped, 42.639)).toBe(0);
  expect(curveAt(stepped, 42.64)).toBe(1);
  expect(curveAt(stepped, 0)).toBe(0);
});

test("cue offsets, looped audio and clip boundaries do not bleed into another state", () => {
  const out = new Float32Array(24);
  mixCue(out, new Float32Array([1, 0.5]), cue, 20);
  expect(Array.from(out.slice(0, 10))).toEqual(Array(10).fill(0));
  expect(Array.from(out.slice(10, 20))).toEqual([0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 0.5, 0.25]);
  expect(Array.from(out.slice(20))).toEqual([0, 0, 0, 0]);
  expect(cueGain({ ...cue, fadeIn: 0.2 }, 0.5)).toBe(0);
  expect(cueGain(cue, 1)).toBe(0);
});

test("full lighting follows music energy, fades at the boundaries and never exceeds its level", () => {
  const intro: Introduction = { duration: 6, audio: [], curves: Object.fromEntries(names.map(name => [name, [key(0, name === "Waveform/m_IsActive" ? 1 : 0)]])) };
  const silent = new Float32Array(600);
  const music = Float32Array.from({ length: 600 }, (_, i) => i > 200 && i < 400 ? 0.7 : 0);
  const values = introductionIntensities(intro, { music, rain: silent, thunder: silent }, 100, 40);
  expect(values).toHaveLength(240);
  expect(values[0]).toBe(0);
  expect(values.at(-1)).toBe(0);
  expect(values[120]).toBeGreaterThan(values[60]!);
  expect(values[120]).toBeGreaterThan(values[200]!);
  expect(values.every(v => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
});
