// Video surfaces: where a point in the room lands in a surface's picture.
//
// Everything is in the surface's LOCAL space (the node's transform takes care of the room), and a
// picture coordinate is (u, v) with u 0→1 left to right and v 0→1 TOP to BOTTOM — image rows, the
// way a decoded frame is stored. Three shapes share one interface:
//
//   planar    a rectangle in the local XY plane, centred, facing +Z. A point projects straight
//             along Z onto it (an orthographic projector), so depth does not matter. Seen from the
//             +Z side the picture reads the right way round: +X is picture-right, +Y picture-up.
//   dome      a fisheye (domemaster) picture. The picture's centre is straight up (+Y), its edge
//             is `fov`/2 away from that, its BOTTOM is the front (−Z) and its right is +X — what
//             an audience under a dome facing −Z sees.
//   equirect  a full sphere, latitude/longitude. The picture's centre is the front (−Z), +X is to
//             the right of it, the top row is straight up.
//
// Dome and equirect depend only on the DIRECTION of a point from the surface's origin, so their
// radius changes what is drawn and what "nearest" measures to, never what a light samples.
//
// Two ways to ask, the same code underneath:
//   projectLocal   "is this point in the picture's throw, and where?"  → null when it is not
//   nearestLocal   "what is the closest point ON the surface?"         → always answers
//
// Pure TypeScript: the browser preview, the Bun bake and the viewport's mesh all come from here,
// so what is drawn is what is sampled.

import type { VideoSurface } from "./rig";
import type { Vec3 } from "./transform";

export type UV = [number, number];

const DEG = Math.PI / 180;
const EDGE = 1e-6;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Where a local point lands in the picture when projected, or null if the surface does not cover it. */
export function projectLocal(s: VideoSurface, p: Vec3): UV | null {
  if (s.projection === "planar") {
    const u = p[0] / s.width + 0.5;
    const v = 0.5 - p[1] / s.height;
    // A hair of tolerance, so a pixel placed exactly on the edge is not lost to rounding.
    return u >= -EDGE && u <= 1 + EDGE && v >= -EDGE && v <= 1 + EDGE ? [clamp01(u), clamp01(v)] : null;
  }
  const len = Math.hypot(p[0], p[1], p[2]);
  if (len < 1e-9) return null;
  const d: Vec3 = [p[0] / len, p[1] / len, p[2] / len];
  if (s.projection === "dome") {
    const theta = Math.acos(Math.max(-1, Math.min(1, d[1])));
    const half = (s.fov / 2) * DEG;
    return theta <= half + EDGE ? domeUV(d, Math.min(theta, half), half) : null;
  }
  return equirectUV(d);
}

/** The closest point on the surface to a local point, and its picture coordinate. */
export function nearestLocal(s: VideoSurface, p: Vec3): { point: Vec3; uv: UV } {
  if (s.projection === "planar") {
    const x = Math.max(-s.width / 2, Math.min(s.width / 2, p[0]));
    const y = Math.max(-s.height / 2, Math.min(s.height / 2, p[1]));
    return { point: [x, y, 0], uv: [x / s.width + 0.5, 0.5 - y / s.height] };
  }
  const len = Math.hypot(p[0], p[1], p[2]);
  // At the exact centre every direction is as near as any other; pick straight up.
  let d: Vec3 = len < 1e-9 ? [0, 1, 0] : [p[0] / len, p[1] / len, p[2] / len];
  if (s.projection === "dome") {
    const half = (s.fov / 2) * DEG;
    let theta = Math.acos(Math.max(-1, Math.min(1, d[1])));
    if (theta > half) {
      // Below the dome's rim: slide up the same meridian to the rim.
      const h = Math.hypot(d[0], d[2]);
      const [hx, hz] = h < 1e-9 ? [0, -1] : [d[0] / h, d[2] / h];
      theta = half;
      d = [Math.sin(theta) * hx, Math.cos(theta), Math.sin(theta) * hz];
    }
    return { point: [d[0] * s.radius, d[1] * s.radius, d[2] * s.radius], uv: domeUV(d, theta, half) };
  }
  return { point: [d[0] * s.radius, d[1] * s.radius, d[2] * s.radius], uv: equirectUV(d) };
}

function domeUV(d: Vec3, theta: number, half: number): UV {
  const r = theta / half; // equidistant fisheye: distance from the picture's centre grows with angle
  const h = Math.hypot(d[0], d[2]);
  if (h < 1e-9) return [0.5, 0.5];
  return [0.5 + 0.5 * r * (d[0] / h), 0.5 - 0.5 * r * (d[2] / h)];
}

function equirectUV(d: Vec3): UV {
  const lon = Math.atan2(d[0], -d[2]);
  const lat = Math.asin(Math.max(-1, Math.min(1, d[1])));
  return [0.5 + lon / (2 * Math.PI), 0.5 - lat / Math.PI];
}

/** True if the picture wraps around horizontally (so sampling near u=0 should blend with u=1). */
export const wrapsU = (s: VideoSurface) => s.projection === "equirect";

export interface SurfaceMesh {
  /** xyz per vertex, local space. */
  positions: Float32Array;
  /** uv per vertex, v measured from the TOP of the picture. */
  uvs: Float32Array;
  indices: Uint32Array;
}

/**
 * The surface as a triangle grid for the viewport to draw. Vertices are generated from the picture
 * coordinate outwards — the inverse of projectLocal — so the equirect seam and the dome's pole are
 * exact rather than rediscovered from positions.
 */
export function surfaceMesh(s: VideoSurface): SurfaceMesh {
  const [nu, nv] = s.projection === "planar" ? [1, 1] : s.projection === "dome" ? [48, 12] : [48, 24];
  const positions = new Float32Array((nu + 1) * (nv + 1) * 3);
  const uvs = new Float32Array((nu + 1) * (nv + 1) * 2);
  let k = 0;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++, k++) {
      const a = i / nu;
      const b = j / nv;
      let p: Vec3;
      let uv: UV;
      if (s.projection === "planar") {
        p = [(a - 0.5) * s.width, (0.5 - b) * s.height, 0];
        uv = [a, b];
      } else if (s.projection === "dome") {
        // a: once round the zenith; b: zenith → rim.
        const phi = a * 2 * Math.PI;
        const theta = b * (s.fov / 2) * DEG;
        const d: Vec3 = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
        p = [d[0] * s.radius, d[1] * s.radius, d[2] * s.radius];
        uv = [0.5 + 0.5 * b * Math.cos(phi), 0.5 - 0.5 * b * Math.sin(phi)];
      } else {
        const lon = (a - 0.5) * 2 * Math.PI;
        const lat = (0.5 - b) * Math.PI;
        p = [Math.cos(lat) * Math.sin(lon) * s.radius, Math.sin(lat) * s.radius, -Math.cos(lat) * Math.cos(lon) * s.radius];
        uv = [a, b];
      }
      positions.set(p, k * 3);
      uvs.set(uv, k * 2);
    }
  }
  const indices = new Uint32Array(nu * nv * 6);
  let t = 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const v0 = j * (nu + 1) + i;
      const v1 = v0 + 1;
      const v2 = v0 + nu + 1;
      const v3 = v2 + 1;
      indices.set([v0, v2, v1, v1, v2, v3], t);
      t += 6;
    }
  }
  return { positions, uvs, indices };
}
