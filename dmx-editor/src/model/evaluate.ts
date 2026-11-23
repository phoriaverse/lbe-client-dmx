// The evaluator: a sequence at one instant → one frame of linear light, in rig order.
//
// There is ONE of these. The browser preview calls it with pictures grabbed from <video> elements;
// the Bun bake calls it with pictures decoded by ffmpeg. Everything between "a decoded picture" and
// "a frame of linear light" is this file, so what is previewed is what is baked. Nothing here
// touches three.js, the DOM or the file system.
//
// It is split in two because the geometry is static (until milestone 4 keyframes transforms):
//
//   buildPlan(rig, sequence)      once per document change: for every pixel, which surface(s) it
//                                 samples and at what picture coordinate.
//   evaluateFrame(plan, pictures) per frame: look the pictures up, convert to linear light, sum.
//
// The scene is dark by default: a pixel no surface covers is 0. Surfaces add.

import { pixelMap, worldMatrices } from "./pixels";
import type { RigDocument } from "./rig";
import { activeSurfaces, type SequenceDocument } from "./sequence";
import { nearestLocal, projectLocal, wrapsU } from "./surfaces";
import { invert, transformPoint, type Vec3 } from "./transform";

/** One decoded picture: 8-bit sRGB-encoded, rows top to bottom, `stride` bytes per pixel (3 RGB or 4 RGBA). */
export interface Picture {
  width: number;
  height: number;
  stride: 3 | 4;
  data: Uint8Array | Uint8ClampedArray;
}

export interface SurfacePlan {
  /** Rig node id of the surface. */
  surface: string;
  video: string;
  gain: number;
  wrapU: boolean;
  /** Frame pixel indices this surface lights. */
  pixels: Uint32Array;
  /** u, v per entry of `pixels`. */
  uvs: Float32Array;
}

export interface SamplePlan {
  pixelCount: number;
  level: number;
  surfaces: SurfacePlan[];
}

export function buildPlan(rig: RigDocument, seq: SequenceDocument): SamplePlan {
  const map = pixelMap(rig);
  const worlds = worldMatrices(rig);
  const n = map.pixelCount;
  const point = (i: number): Vec3 => [map.positions[i * 3]!, map.positions[i * 3 + 1]!, map.positions[i * 3 + 2]!];

  const surfaces = activeSurfaces(rig, seq).flatMap((s) => {
    const world = worlds.get(s.node.id)!;
    const inverse = invert(world);
    // A surface scaled to nothing has no inside to project into.
    return inverse ? [{ ...s, world, inverse, pixels: [] as number[], uvs: [] as number[] }] : [];
  });

  if (seq.sampling === "projection") {
    for (const s of surfaces) {
      for (let i = 0; i < n; i++) {
        const uv = projectLocal(s.node.surface, transformPoint(s.inverse, point(i)));
        if (uv) {
          s.pixels.push(i);
          s.uvs.push(uv[0], uv[1]);
        }
      }
    }
  } else {
    // Nearest: distance is measured in the room (world metres), not in each surface's own scale.
    for (let i = 0; i < n; i++) {
      const p = point(i);
      let best: (typeof surfaces)[number] | null = null;
      let bestUV: [number, number] = [0, 0];
      let bestDistance = Infinity;
      for (const s of surfaces) {
        const near = nearestLocal(s.node.surface, transformPoint(s.inverse, p));
        const w = transformPoint(s.world, near.point);
        const distance = Math.hypot(w[0] - p[0], w[1] - p[1], w[2] - p[2]);
        if (distance < bestDistance) {
          best = s;
          bestUV = near.uv;
          bestDistance = distance;
        }
      }
      if (best) {
        best.pixels.push(i);
        best.uvs.push(bestUV[0], bestUV[1]);
      }
    }
  }

  return {
    pixelCount: n,
    level: seq.level,
    surfaces: surfaces.map((s) => ({
      surface: s.node.id,
      video: s.video,
      gain: s.gain,
      wrapU: wrapsU(s.node.surface),
      pixels: Uint32Array.from(s.pixels),
      uvs: Float32Array.from(s.uvs),
    })),
  };
}

/** sRGB-encoded byte → linear light. Video is BT.709, whose display curve this is close enough to. */
const SRGB_TO_LINEAR = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

/**
 * One frame. `pictureOf` hands back each video's picture at the instant being evaluated, or null if
 * it has none (not loaded, or past its end) — that surface is then dark. Returns `out`, R G B per
 * pixel in linear light, clamped to 0–1.
 */
export function evaluateFrame(plan: SamplePlan, pictureOf: (video: string) => Picture | null, out: Float32Array = new Float32Array(plan.pixelCount * 3)): Float32Array {
  out.fill(0);
  for (const s of plan.surfaces) {
    const pic = pictureOf(s.video);
    if (!pic) continue;
    const k = s.gain * plan.level;
    if (!(k > 0)) continue;
    const { width: w, height: h, stride, data } = pic;
    for (let j = 0; j < s.pixels.length; j++) {
      // Bilinear, texel centres at half-integers. Edges clamp; an equirect picture wraps in u.
      const x = s.uvs[j * 2]! * w - 0.5;
      const y = s.uvs[j * 2 + 1]! * h - 0.5;
      const xf = Math.floor(x);
      const yf = Math.floor(y);
      const fx = x - xf;
      const fy = y - yf;
      const x0 = s.wrapU ? (((xf % w) + w) % w) : Math.max(0, Math.min(w - 1, xf));
      const x1 = s.wrapU ? (x0 + 1) % w : Math.max(0, Math.min(w - 1, xf + 1));
      const y0 = Math.max(0, Math.min(h - 1, yf));
      const y1 = Math.max(0, Math.min(h - 1, yf + 1));
      const a = (y0 * w + x0) * stride;
      const b = (y0 * w + x1) * stride;
      const c = (y1 * w + x0) * stride;
      const d = (y1 * w + x1) * stride;
      const wa = (1 - fx) * (1 - fy);
      const wb = fx * (1 - fy);
      const wc = (1 - fx) * fy;
      const wd = fx * fy;
      const o = s.pixels[j]! * 3;
      // Blend in linear light: averaging encoded values would darken every edge.
      for (let ch = 0; ch < 3; ch++) {
        out[o + ch]! += k * (wa * SRGB_TO_LINEAR[data[a + ch]!]! + wb * SRGB_TO_LINEAR[data[b + ch]!]! + wc * SRGB_TO_LINEAR[data[c + ch]!]! + wd * SRGB_TO_LINEAR[data[d + ch]!]!);
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i]! > 1) out[i] = 1;
  return out;
}
