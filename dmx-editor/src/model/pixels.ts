// Where every pixel is, and frames over them.
//
// A FRAME is pixels in rig order (patch.ts), three linear-light values each. Each pixel's world
// position comes from its light's world transform and its profile's length — that is all the
// evaluator (milestone 3 onward) needs to know about the room, and it runs identically in the
// browser and in the Bun bake because nothing here touches three.js.

import { encodeSample, type SampleBits, SHOW_TRANSFER } from "../../../dmx-client/src/shared/show-file";
import { driveToLinear, linearToDrive } from "../../../dmx-client/src/shared/brightness";
import { rigOrder } from "./patch";
import { nodeById, profileById, type RigDocument, type RigNode } from "./rig";
import { compose, identity, type Mat4, multiply, transformPoint, type Vec3 } from "./transform";

/** World matrix of every node. A cycle or a dangling parent is treated as the root, not an error. */
export function worldMatrices(rig: RigDocument): Map<string, Mat4> {
  const out = new Map<string, Mat4>();
  const visiting = new Set<string>();
  const resolve = (node: RigNode): Mat4 => {
    const done = out.get(node.id);
    if (done) return done;
    if (visiting.has(node.id)) return identity();
    visiting.add(node.id);
    const parent = node.parent ? nodeById(rig, node.parent) : undefined;
    const local = compose(node.transform);
    const world = parent ? multiply(resolve(parent), local) : local;
    visiting.delete(node.id);
    out.set(node.id, world);
    return world;
  };
  for (const n of rig.nodes) resolve(n);
  return out;
}

/** Pixel i of n along a fixture of `length`, in the light's local space: along +X, centred, pixel 0 at −X. */
export function localPixel(i: number, n: number, length: number): Vec3 {
  return [-length / 2 + ((i + 0.5) * length) / n, 0, 0];
}

export interface PixelMap {
  pixelCount: number;
  /** xyz per pixel, rig order, world metres. */
  positions: Float32Array;
  spans: ReturnType<typeof rigOrder>;
}

export function pixelMap(rig: RigDocument): PixelMap {
  const spans = rigOrder(rig);
  const worlds = worldMatrices(rig);
  const pixelCount = spans.reduce((n, s) => n + s.count, 0);
  const positions = new Float32Array(pixelCount * 3);
  for (const span of spans) {
    const profile = profileById(rig, span.light.light!.profile)!;
    const world = worlds.get(span.light.id)!;
    for (let i = 0; i < span.count; i++) {
      const p = transformPoint(world, localPixel(i, span.count, profile.length));
      positions.set(p, (span.first + i) * 3);
    }
  }
  return { pixelCount, positions, spans };
}

/** A dark frame: linear light, R G B per pixel. The scene is dark by default. */
export const darkFrame = (pixelCount: number) => new Float32Array(pixelCount * 3);

/** Estimate the light after the same sample encoding, levels, gains and DMX quantisation as live output. */
export function estimateFixtureFrame(rig: RigDocument, frame: Float32Array, level = 1): Float32Array {
  const out = new Float32Array(frame.length);
  for (const span of rigOrder(rig)) {
    if (!span.chain) continue;
    const profile = profileById(rig, span.light.light!.profile)!;
    const gain = profile.gain ?? [1, 1, 1];
    for (let p = span.first; p < span.first + span.count; p++) {
      for (let c = 0; c < 3; c++) {
        const i = p * 3 + c;
        if (i >= frame.length) continue;
        const sample = encodeSample(frame[i]!, 8);
        const light = Math.pow(sample / 255, SHOW_TRANSFER) * Math.max(0, level) * Math.max(0, gain[c]!);
        out[i] = driveToLinear(linearToDrive(light, profile.gamma) / 255, profile.gamma);
      }
    }
  }
  return out;
}

/**
 * Identify: the chosen lights at a dim white, with pixel 0 (the data-in end) red so a tube placed
 * backwards in the model is obvious on the real one. Everything else dark. `on` is the blink phase.
 *
 * Levels are linear light before the client's master and cap (cap 0.5 on site), so 0.12 reaches the
 * wall as at most 6% — enough to find a tube in a lit room, nowhere near the untested full-chain load.
 */
export function identifyFrame(rig: RigDocument, lightIds: ReadonlySet<string>, on: boolean, level = 0.12): Float32Array {
  const spans = rigOrder(rig);
  const frame = darkFrame(spans.reduce((n, s) => n + s.count, 0));
  if (!on) return frame;
  for (const span of spans) {
    if (!lightIds.has(span.light.id)) continue;
    for (let i = 0; i < span.count; i++) {
      const o = (span.first + i) * 3;
      if (i === 0) frame.set([level * 2, 0, 0], o);
      else frame.set([level, level, level], o);
    }
  }
  return frame;
}

/** Linear frame → wire samples, the same encoding a .show frame uses. */
export function encodeFrame(frame: Float32Array, bits: SampleBits = 8, transfer = SHOW_TRANSFER): Uint8Array {
  if (bits === 8) {
    const out = new Uint8Array(frame.length);
    for (let i = 0; i < frame.length; i++) out[i] = encodeSample(frame[i]!, 8, transfer);
    return out;
  }
  const out = new Uint8Array(frame.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < frame.length; i++) view.setUint16(i * 2, encodeSample(frame[i]!, 16, transfer), true);
  return out;
}
