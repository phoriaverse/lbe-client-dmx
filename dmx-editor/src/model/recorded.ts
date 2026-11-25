import { frameView, parseShow } from "../../../dmx-client/src/shared/show-file";

/** Self-contained score. Fixture IDs retain tube identity when the room layout or wire order changes. */
export interface RecordedLighting {
  description: string;
  fixtures: { id: string; count: number }[];
  showBase64: string;
}

const cache = new WeakMap<RecordedLighting, ReturnType<typeof decode>>();
function decode(track: RecordedLighting) {
  const bytes = Uint8Array.from(atob(track.showBase64), c => c.charCodeAt(0));
  const show = parseShow(bytes, bytes.length);
  if (track.fixtures.reduce((n, f) => n + f.count, 0) !== show.header.pixelCount)
    throw new Error("Recorded score fixture counts do not match its pixels");
  return { bytes, show };
}
export function recordedShow(track: RecordedLighting) {
  let value = cache.get(track);
  if (!value) { value = decode(track); cache.set(track, value); }
  return value;
}

export function recordedFrame(track: RecordedLighting, mapping: Int32Array, timeMs: number, level: number, out: Float32Array) {
  const { bytes, show } = recordedShow(track), { header } = show;
  let index = Math.floor(timeMs * header.fps / 1000);
  if (!Number.isFinite(index) || index < 0) return out;
  if (header.loop) index %= header.frameCount;
  if (index >= header.frameCount) return out;
  const source = frameView(bytes, show, index), max = header.bits === 16 ? 65535 : 255;
  for (let p = 0; p < mapping.length; p++) if (mapping[p]! >= 0)
    for (let c = 0; c < 3; c++) out[p * 3 + c] = Math.min(1, Math.pow(source[mapping[p]! * 3 + c]! / max, header.transfer) * level);
  return out;
}
