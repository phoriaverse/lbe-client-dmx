// Transforms, Unity-style: every node has a LOCAL position / rotation / scale relative to its parent,
// and its world matrix is parent's world × its own. Rotation is Euler angles in DEGREES, applied in
// the order yaw (Y) · pitch (X) · roll (Z) — Unity's inspector order, and three.js's Euler order
// "YXZ". Metres, Y-up.
//
// This is pure TypeScript on purpose. The evaluator that turns a sequence into frames runs in the
// Bun bake as well as in the browser, and it needs every pixel's world position — so the maths that
// places pixels cannot live in three.js, which only draws. The viewport builds the same hierarchy
// in three.js with the same Euler order; test/transform.test.ts pins the two against each other.
//
// Matrices are 16 numbers, column-major (element [col*4 + row]), the layout three.js uses, so they
// can be handed to it directly when that is ever convenient.

export type Vec3 = [number, number, number];
export type Mat4 = Float64Array;

export interface Transform {
  position: Vec3;
  /** Euler degrees, applied Y then X then Z (three.js order "YXZ"). */
  rotation: Vec3;
  scale: Vec3;
}

export const identityTransform = (): Transform => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });

const DEG = Math.PI / 180;

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** T · R · S, where R = Ry · Rx · Rz. Same numbers as three's Matrix4.compose with Euler order YXZ. */
export function compose(t: Transform): Mat4 {
  const [px, py, pz] = t.position;
  const [sx, sy, sz] = t.scale;
  const x = t.rotation[0] * DEG;
  const y = t.rotation[1] * DEG;
  const z = t.rotation[2] * DEG;
  const a = Math.cos(x), b = Math.sin(x);
  const c = Math.cos(y), d = Math.sin(y);
  const e = Math.cos(z), f = Math.sin(z);
  const ce = c * e, cf = c * f, de = d * e, df = d * f;

  const m = new Float64Array(16);
  m[0] = (ce + df * b) * sx;
  m[1] = a * f * sx;
  m[2] = (cf * b - de) * sx;
  m[4] = (de * b - cf) * sy;
  m[5] = a * e * sy;
  m[6] = (df + ce * b) * sy;
  m[8] = a * d * sz;
  m[9] = -b * sz;
  m[10] = a * c * sz;
  m[12] = px;
  m[13] = py;
  m[14] = pz;
  m[15] = 1;
  return m;
}

/** a × b */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = s;
    }
  }
  return out;
}

/**
 * Inverse of an affine matrix (bottom row 0 0 0 1 — every matrix compose() makes). Returns null for
 * a singular one (a zero scale somewhere).
 */
export function invert(m: Mat4): Mat4 | null {
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, i = m[10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  const o = new Float64Array(16);
  // The 3×3 inverse (adjugate / det), written into the column-major layout.
  o[0] = A * k;
  o[1] = B * k;
  o[2] = C * k;
  o[4] = -(b * i - c * h) * k;
  o[5] = (a * i - c * g) * k;
  o[6] = -(a * h - b * g) * k;
  o[8] = (b * f - c * e) * k;
  o[9] = -(a * f - c * d) * k;
  o[10] = (a * e - b * d) * k;
  // Translation: −R⁻¹ · t
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  o[12] = -(o[0]! * tx + o[4]! * ty + o[8]! * tz);
  o[13] = -(o[1]! * tx + o[5]! * ty + o[9]! * tz);
  o[14] = -(o[2]! * tx + o[6]! * ty + o[10]! * tz);
  o[15] = 1;
  return o;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/**
 * The inverse of compose: matrix → position, YXZ Euler degrees, scale. Only exact for matrices
 * without shear (a non-uniformly scaled parent with a rotated child has shear, as in Unity, and the
 * result is the nearest TRS). Rounded to keep saved files readable and stable across round trips.
 */
export function decompose(m: Mat4): Transform {
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const det = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  if (det < 0) sx = -sx;

  const m11 = m[0]! / sx, m21 = m[1]! / sx, m31 = m[2]! / sx;
  const m12 = m[4]! / sy, m22 = m[5]! / sy;
  const m13 = m[8]! / sz, m23 = m[9]! / sz, m33 = m[10]! / sz;
  void m12;

  const x = Math.asin(-Math.min(1, Math.max(-1, m23)));
  let y: number;
  let z: number;
  if (Math.abs(m23) < 0.9999999) {
    y = Math.atan2(m13, m33);
    z = Math.atan2(m21, m22);
  } else {
    y = Math.atan2(-m31, m11);
    z = 0;
  }
  return {
    position: [tidy(m[12]!), tidy(m[13]!), tidy(m[14]!)],
    rotation: [tidy(x / DEG), tidy(y / DEG), tidy(z / DEG)],
    scale: [tidy(sx), tidy(sy), tidy(sz)],
  };
}

/** Round to 6 decimals (a micron, a microdegree) and fold -0 into 0. */
export function tidy(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}
