// Source-only Unity Timeline reader for the bundled Introduction. No Unity project is modified.
export interface AudioCue {
  name: string; guid: string; start: number; duration: number; clipIn: number;
  fadeIn: number; fadeOut: number; gain: number; loop: boolean;
}
export interface CurveKey { time: number; value: number; inSlope: number; outSlope: number }
export interface Introduction {
  duration: number;
  audio: AudioCue[];
  curves: Record<string, CurveKey[]>;
}

type UnityObject = {
  MonoBehaviour?: {
    m_Name: string; m_EditorClassIdentifier: string; m_FixedDuration: number; m_Muted: number;
    m_Clips?: { m_Start: number; m_Duration: number; m_ClipIn: number; m_TimeScale: number;
      m_EaseInDuration: number; m_EaseOutDuration: number; m_Asset: { fileID: string } }[];
    m_Clip?: { guid: string }; m_Loop: number;
    m_TrackProperties?: { volume: number };
    m_ClipProperties?: { volume: number };
  };
  PlayableDirector?: { m_SceneBindings: { key: { fileID: string }; value: { fileID: string } }[] };
  AudioSource?: { m_Volume: number; Mute: number };
  AnimationClip?: { m_FloatCurves: { path: string; attribute: string;
    curve: { m_Curve: (CurveKey & { inSlope: number | string; outSlope: number | string; weightedMode: number })[] } }[] };
};

function objects(text: string): Map<string, UnityObject> {
  const parts = text.replace(/^%.*\n/gm, "").split(/^--- !u!\d+ &(-?\d+)\n/gm);
  const result = new Map<string, UnityObject>();
  for (let i = 1; i < parts.length; i += 2) {
    // Unity fileIDs are signed 64-bit integers. Keep exact strings across YAML's JS-number boundary.
    const body = parts[i + 1]!.replace(/fileID: (-?\d+)/g, 'fileID: "$1"');
    result.set(parts[i]!, Bun.YAML.parse(body) as UnityObject);
  }
  if (!result.size) throw new Error("No Unity YAML objects found");
  return result;
}

const finite = (n: number, label: string) => {
  if (!Number.isFinite(n)) throw new Error(`Invalid ${label}: ${n}`);
  return n;
};

export function readIntroduction(timeline: string, animation: string, scene: string): Introduction {
  const tracks = objects(timeline), sceneObjects = objects(scene);
  const sources = new Map<string, number>();
  for (const object of sceneObjects.values()) for (const binding of object.PlayableDirector?.m_SceneBindings ?? []) {
    const source = sceneObjects.get(binding.value.fileID)?.AudioSource;
    if (source) sources.set(binding.key.fileID, source.Mute ? 0 : source.m_Volume);
  }
  const root = [...tracks.values()].find(o => o.MonoBehaviour?.m_EditorClassIdentifier?.includes("TimelineAsset"))?.MonoBehaviour;
  const duration = finite(root?.m_FixedDuration!, "Timeline duration");
  if (!(duration > 0)) throw new Error("Timeline must have a positive fixed duration");
  const audio: AudioCue[] = [];
  for (const [id, object] of tracks) {
    const track = object.MonoBehaviour;
    if (!track?.m_EditorClassIdentifier?.includes("AudioTrack") || track.m_Muted) continue;
    if (!sources.has(id)) throw new Error(`Audio track ${track.m_Name} has no scene AudioSource binding`);
    for (const clip of track.m_Clips ?? []) {
      const asset = tracks.get(clip.m_Asset.fileID)?.MonoBehaviour;
      if (!asset?.m_Clip?.guid || clip.m_TimeScale !== 1) throw new Error(`Unsupported audio clip in ${track.m_Name}`);
      const cue: AudioCue = { name: track.m_Name, guid: asset.m_Clip.guid,
        start: finite(clip.m_Start, "clip start"), duration: finite(clip.m_Duration, "clip duration"),
        clipIn: finite(clip.m_ClipIn, "clip in"), fadeIn: finite(clip.m_EaseInDuration, "fade in"),
        fadeOut: finite(clip.m_EaseOutDuration, "fade out"),
        gain: finite(sources.get(id)! * (track.m_TrackProperties?.volume ?? 1) * (asset.m_ClipProperties?.volume ?? 1), "audio gain"),
        loop: Boolean(asset.m_Loop) };
      if (cue.start < 0 || cue.duration <= 0 || cue.start + cue.duration > duration + 0.001) throw new Error(`Clip outside Timeline: ${cue.name}`);
      audio.push(cue);
    }
  }
  const curves: Record<string, CurveKey[]> = {};
  const animationClip = [...objects(animation).values()].find(o => o.AnimationClip)?.AnimationClip;
  for (const curve of animationClip?.m_FloatCurves ?? []) {
    if (!["Steam", "Waveform", "Rain", "Ripples", "Ceiling pulse", "RingAurora_2"].includes(curve.path)) continue;
    if (!["m_IsActive", "material._Density", "material._GlobalAlpha", "material._GeneralAlpha"].includes(curve.attribute)) continue;
    curves[`${curve.path}/${curve.attribute}`] = curve.curve.m_Curve.map(k => {
      if (k.weightedMode) throw new Error("Weighted animation curves require a new exporter");
      return { time: finite(k.time, "key time"), value: finite(k.value, "key value"),
        inSlope: Number(k.inSlope), outSlope: Number(k.outSlope) };
    });
  }
  for (const name of ["Steam/material._Density", "Waveform/m_IsActive", "Rain/m_IsActive", "Ceiling pulse/material._GlobalAlpha", "RingAurora_2/material._GeneralAlpha"])
    if (!curves[name]?.length) throw new Error(`Missing Introduction curve: ${name}`);
  for (const name of ["Order from Chaos", "Bass Mosaic", "Ceiling swell", "Rain objects"])
    if (!audio.some(c => c.name === name)) throw new Error(`Missing Introduction audio: ${name}`);
  return { duration, audio: audio.sort((a, b) => a.start - b.start), curves };
}

/** Unweighted Unity curves use cubic Hermite tangents; infinite tangents are step keys. */
export function curveAt(keys: CurveKey[], time: number): number {
  if (time <= keys[0]!.time) return keys[0]!.value;
  const index = keys.findIndex(k => k.time > time);
  if (index < 0) return keys.at(-1)!.value;
  const a = keys[index - 1]!, b = keys[index]!, span = b.time - a.time;
  if (!Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope)) return a.value;
  const t = (time - a.time) / span, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * span * a.outSlope
    + (-2 * t3 + 3 * t2) * b.value + (t3 - t2) * span * b.inSlope;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t); };
export function cueGain(cue: AudioCue, time: number): number {
  const local = time - cue.start;
  if (local < 0 || local >= cue.duration) return 0;
  return cue.gain * (cue.fadeIn ? smooth(local / cue.fadeIn) : 1)
    * (cue.fadeOut ? smooth((cue.duration - local) / cue.fadeOut) : 1);
}

/** Approximate the authored soundtrack for analysis; spatial panning stays in the Quest. */
export function mixCue(out: Float32Array, input: Float32Array, cue: AudioCue, rate: number) {
  if (!input.length) throw new Error(`Empty audio for ${cue.name}`);
  const from = Math.round(cue.start * rate), count = Math.round(cue.duration * rate);
  for (let i = 0; i < count && from + i < out.length; i++) {
    let sample = Math.round(cue.clipIn * rate) + i;
    if (cue.loop) sample %= input.length;
    if (sample < input.length) out[from + i]! += input[sample]! * cueGain(cue, (from + i) / rate);
  }
}

function envelope(audio: Float32Array, rate: number, fps: number, count: number): number[] {
  const rms = Array.from({ length: count }, (_, f) => {
    const start = Math.round(f * rate / fps), end = Math.min(audio.length, Math.round((f + 1) * rate / fps));
    let power = 0;
    for (let i = start; i < end; i++) power += audio[i]! ** 2;
    return Math.sqrt(power / Math.max(1, end - start));
  });
  const positive = rms.filter(v => v > 1e-6).sort((a, b) => a - b);
  const reference = positive[Math.floor((positive.length - 1) * 0.95)] ?? 1;
  return rms.map(v => clamp(v / reference));
}

export function introductionIntensities(intro: Introduction, buses: Record<"music" | "rain" | "thunder", Float32Array>, rate: number, fps: number): number[] {
  const count = Math.round(intro.duration * fps);
  const music = envelope(buses.music, rate, fps, count), rain = envelope(buses.rain, rate, fps, count), thunder = envelope(buses.thunder, rate, fps, count);
  const curve = (name: string, t: number) => clamp(curveAt(intro.curves[name]!, t));
  let previous = 0;
  return Array.from({ length: count }, (_, f) => {
    const t = f / fps;
    const waveform = curve("Waveform/m_IsActive", t), wet = curve("Rain/m_IsActive", t);
    const target = clamp(0.03 * curve("Steam/material._Density", t) + 0.10 * wet
      + 0.55 * music[f]! * (0.3 + 0.7 * waveform) + 0.16 * rain[f]! * wet + 0.16 * thunder[f]!
      + 0.22 * curve("Ceiling pulse/material._GlobalAlpha", t) + 0.10 * curve("RingAurora_2/material._GeneralAlpha", t));
    const timeConstant = target > previous ? 0.08 : 0.25;
    previous += (target - previous) * (1 - Math.exp(-1 / (fps * timeConstant)));
    const fade = smooth(t / 2) * smooth((intro.duration - t) / 1.5);
    return f === count - 1 ? 0 : Math.round(previous * fade * 100000) / 100000;
  });
}
