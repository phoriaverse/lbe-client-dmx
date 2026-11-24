/** The reference exponent used by the patch's fixture gamma (distinct from sRGB). */
export const PERCEPTUAL_GAMMA = 2.2;

/** Linear light → the fixture's quantised 8-bit DMX drive. */
export const linearToDrive = (light: number, fixtureGamma: number) =>
  Math.round(Math.pow(Math.min(1, Math.max(0, light)), fixtureGamma / PERCEPTUAL_GAMMA) * 255);

/** Inverse of drive = light^(fixtureGamma / 2.2). Assumes the profile matches the fixture. */
export const driveToLinear = (drive: number, fixtureGamma: number) =>
  Math.pow(Math.min(1, Math.max(0, drive)), PERCEPTUAL_GAMMA / fixtureGamma);

/** IEC sRGB encoding for an estimated linear-light value, for CSS/canvas display. */
export function linearToSrgb(light: number): number {
  const value = Math.min(1, Math.max(0, light));
  return value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/** CIE L* 0–1 → relative luminance 0–1. An approximate equal-perceived-lightness ramp. */
export function lightnessToLinear(lightness: number): number {
  const l = Math.min(1, Math.max(0, lightness)) * 100;
  return l <= 8 ? l / (24389 / 27) : Math.pow((l + 16) / 116, 3);
}
