// The patch: how a flat frame of pixels maps onto Art-Net universes.
//
// A FRAME is just N pixels in "frame order" — pixel 0 … N-1, three colour values each. Nothing in a
// frame says where a pixel physically is or which wire it hangs off. The patch is the other half: it
// says "frame pixels 0–31 are a GRB tube on gateway A starting at universe 0 channel 1", and so on.
//
// Everything that turns colour into bytes on a wire goes through here, for the client (playback),
// the editor (bake + live preview) and the tools alike. It is pure — no sockets, no clock — so the
// packing rules can be tested without hardware. This file is in src/shared/ because dmx-editor
// imports it too: there is ONE definition of the patch, the same rule the wire protocol follows.

/** Channel order on the wire. Three letters = RGB pixel; four = RGBW (W derived from min(R,G,B)). */
export type ColourOrder = "RGB" | "RBG" | "GRB" | "GBR" | "BRG" | "BGR" | "RGBW" | "GRBW";

export const COLOUR_ORDERS: readonly ColourOrder[] = ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR", "RGBW", "GRBW"];

export const DMX_UNIVERSE_SIZE = 512;
export const ARTNET_PORT = 6454;
/** Art-Net's 15-bit port-address: 7-bit net, 4-bit subnet, 4-bit universe. */
export const MAX_PORT_ADDRESS = 0x7fff;

export interface Gateway {
  /** Stable id the runs refer to. Not the IP — a gateway keeps its id when it is readdressed. */
  id: string;
  name?: string;
  host: string;
  /** Destination UDP port. 6454 for real hardware; the simulated gateway listens elsewhere. */
  port?: number;
}

/**
 * A contiguous stretch of frame pixels on one gateway output — in practice one fixture (one tube).
 *
 * Pixels fill channels consecutively from (universe, channel). A pixel never straddles two
 * universes: when the next one would not fit in the 512, the run continues at channel 1 of the next
 * universe. For a 3-channel pixel starting at channel 1 that is 170 pixels (510 channels) per
 * universe — the rule the CL-104PS uses, bench-verified on the CL05 tubes.
 */
export interface PixelRun {
  /** Index in the frame of this run's first pixel. */
  first: number;
  /** Number of pixels. */
  count: number;
  /** Gateway id. */
  gateway: string;
  /** Art-Net port-address (0-based, as on the wire) of the run's first pixel. */
  universe: number;
  /** 1-based DMX channel of the run's first pixel, as on a lighting desk. */
  channel: number;
  order: ColourOrder;
  /**
   * The exponent that turns a perceptual level (0–1, what a fade "looks like") into this fixture's
   * drive level. 2.2 for a linear-PWM pixel like the CL05 — 0→31 on the wire is a far bigger visible
   * step than 31→255, so an uncorrected fade lurches. 1.0 for a fixture that already applies its own
   * dimming curve. See output.ts for where it is applied.
   */
  gamma: number;
  /** Per-channel trim in linear light, for white-balancing a fixture type by eye. Default [1,1,1]. */
  gain?: [number, number, number];
}

export interface Patch {
  /** Pixels per frame. Runs may cover fewer (unpatched pixels are simply never sent). */
  pixelCount: number;
  gateways: Gateway[];
  runs: PixelRun[];
}

/** Where the pixel AFTER the last one of this run would land: the next free (universe, channel). */
export function endOfRun(run: Pick<PixelRun, "count" | "universe" | "channel" | "order">): { universe: number; channel: number } {
  const width = run.order.length;
  let universe = run.universe;
  let offset = run.channel - 1;
  for (let i = 0; i < run.count; i++) {
    if (offset + width > DMX_UNIVERSE_SIZE) {
      universe += 1;
      offset = 0;
    }
    offset += width;
  }
  // The NEXT pixel wraps too if it would not fit — report where it would really go.
  if (offset + width > DMX_UNIVERSE_SIZE) return { universe: universe + 1, channel: 1 };
  return { universe, channel: offset + 1 };
}

export interface ChainFixture {
  count: number;
  order: ColourOrder;
  gamma: number;
  gain?: [number, number, number];
}

/**
 * Patch a daisy chain: fixtures in wire order off one gateway output, each starting on the channel
 * after the previous one ended. This is how pixel tubes actually address — there is no per-fixture
 * start address to set, only position in the chain.
 */
export function chainRuns(
  gateway: string,
  fixtures: readonly ChainFixture[],
  start: { first?: number; universe?: number; channel?: number } = {},
): PixelRun[] {
  const runs: PixelRun[] = [];
  let first = start.first ?? 0;
  let universe = start.universe ?? 0;
  let channel = start.channel ?? 1;
  for (const f of fixtures) {
    const run: PixelRun = { first, count: f.count, gateway, universe, channel, order: f.order, gamma: f.gamma };
    if (f.gain) run.gain = f.gain;
    runs.push(run);
    ({ universe, channel } = endOfRun(run));
    first += f.count;
  }
  return runs;
}

/** The whole rig as one gateway and one chain of identical fixtures — the bench rig, and the tests. */
export function simplePatch(opts: {
  host: string;
  port?: number;
  fixtures: number;
  pixelsPerFixture: number;
  order?: ColourOrder;
  gamma?: number;
  universe?: number;
}): Patch {
  const gateway: Gateway = { id: "gw1", host: opts.host };
  if (opts.port !== undefined) gateway.port = opts.port;
  const fixture: ChainFixture = { count: opts.pixelsPerFixture, order: opts.order ?? "GRB", gamma: opts.gamma ?? 2.2 };
  const start = opts.universe === undefined ? {} : { universe: opts.universe };
  return {
    pixelCount: opts.fixtures * opts.pixelsPerFixture,
    gateways: [gateway],
    runs: chainRuns(gateway.id, Array.from({ length: opts.fixtures }, () => fixture), start),
  };
}

// ── Compiled form ────────────────────────────────────────────────────────────

/** One universe's worth of output: who it goes to, and how much of the 512 is actually in use. */
export interface UniverseSlot {
  gateway: Gateway;
  universe: number;
  /** Highest channel (1-based) any pixel writes. */
  used: number;
}

/**
 * The patch flattened for the per-frame inner loop: for every frame pixel, which universe buffer it
 * writes to and at what byte offset. Built once per patch, read 40 times a second.
 */
export interface CompiledPatch {
  patch: Patch;
  slots: UniverseSlot[];
  /** Per pixel: index into `slots`, or -1 if the pixel is unpatched. */
  slotOf: Int32Array;
  /** Per pixel: 0-based byte offset of its first channel within its universe. */
  offsetOf: Int32Array;
  /** Per pixel: index into `patch.runs` (or -1) — the run carries order, gamma and gain. */
  runOf: Int32Array;
}

const slotKey = (gateway: string, universe: number) => `${gateway}\u0000${universe}`;

/** Every problem with a patch that would make its output wrong, in words an operator can act on. */
export function validatePatch(patch: Patch): string[] {
  const problems: string[] = [];
  const gateways = new Map<string, Gateway>();
  for (const g of patch.gateways) {
    if (gateways.has(g.id)) problems.push(`gateway id "${g.id}" is used twice`);
    gateways.set(g.id, g);
    if (!g.host) problems.push(`gateway "${g.id}" has no host`);
  }

  if (!Number.isInteger(patch.pixelCount) || patch.pixelCount < 0) problems.push(`pixelCount ${patch.pixelCount} is not a whole number`);

  const pixelOwner = new Int32Array(Math.max(0, patch.pixelCount)).fill(-1);
  const channelOwner = new Map<string, Int32Array>(); // per universe: run index per channel

  patch.runs.forEach((run, r) => {
    const label = `run ${r} (pixels ${run.first}–${run.first + run.count - 1})`;
    if (!gateways.has(run.gateway)) problems.push(`${label} names unknown gateway "${run.gateway}"`);
    if (!COLOUR_ORDERS.includes(run.order)) problems.push(`${label} has unknown colour order "${run.order}"`);
    if (!(run.gamma > 0)) problems.push(`${label} has gamma ${run.gamma}; it must be above 0`);
    if (!Number.isInteger(run.count) || run.count < 1) problems.push(`${label} has count ${run.count}`);
    if (!Number.isInteger(run.first) || run.first < 0 || run.first + run.count > patch.pixelCount) {
      problems.push(`${label} runs past the frame's ${patch.pixelCount} pixels`);
      return;
    }
    if (!Number.isInteger(run.channel) || run.channel < 1 || run.channel > DMX_UNIVERSE_SIZE) {
      problems.push(`${label} starts at channel ${run.channel}; channels are 1–${DMX_UNIVERSE_SIZE}`);
      return;
    }
    if (!Number.isInteger(run.universe) || run.universe < 0) {
      problems.push(`${label} starts at universe ${run.universe}`);
      return;
    }

    const width = run.order.length;
    let universe = run.universe;
    let offset = run.channel - 1;
    for (let i = 0; i < run.count; i++) {
      if (offset + width > DMX_UNIVERSE_SIZE) {
        universe += 1;
        offset = 0;
      }
      if (universe > MAX_PORT_ADDRESS) {
        problems.push(`${label} runs past Art-Net's last universe (${MAX_PORT_ADDRESS})`);
        return;
      }

      const pixel = run.first + i;
      if (pixelOwner[pixel] !== -1 && pixelOwner[pixel] !== r) {
        problems.push(`pixel ${pixel} is patched twice (runs ${pixelOwner[pixel]} and ${r})`);
        return;
      }
      pixelOwner[pixel] = r;

      const key = slotKey(run.gateway, universe);
      let owners = channelOwner.get(key);
      if (!owners) channelOwner.set(key, (owners = new Int32Array(DMX_UNIVERSE_SIZE).fill(-1)));
      for (let c = 0; c < width; c++) {
        const other = owners[offset + c]!;
        if (other !== -1 && other !== r) {
          problems.push(`runs ${other} and ${r} both write gateway "${run.gateway}" universe ${universe} channel ${offset + c + 1}`);
          return;
        }
        owners[offset + c] = r;
      }
      offset += width;
    }
  });

  return problems;
}

/** Flatten a patch for output. Throws on an invalid patch — callers validate first to report nicely. */
export function compilePatch(patch: Patch): CompiledPatch {
  const problems = validatePatch(patch);
  if (problems.length) throw new Error(`invalid patch: ${problems.join("; ")}`);

  const gateways = new Map(patch.gateways.map((g) => [g.id, g]));
  const slots: UniverseSlot[] = [];
  const slotIndex = new Map<string, number>();
  const slotOf = new Int32Array(patch.pixelCount).fill(-1);
  const offsetOf = new Int32Array(patch.pixelCount).fill(-1);
  const runOf = new Int32Array(patch.pixelCount).fill(-1);

  patch.runs.forEach((run, r) => {
    const width = run.order.length;
    let universe = run.universe;
    let offset = run.channel - 1;
    for (let i = 0; i < run.count; i++) {
      if (offset + width > DMX_UNIVERSE_SIZE) {
        universe += 1;
        offset = 0;
      }
      const key = slotKey(run.gateway, universe);
      let s = slotIndex.get(key);
      if (s === undefined) {
        s = slots.length;
        slotIndex.set(key, s);
        slots.push({ gateway: gateways.get(run.gateway)!, universe, used: 0 });
      }
      const slot = slots[s]!;
      slot.used = Math.max(slot.used, offset + width);

      const pixel = run.first + i;
      slotOf[pixel] = s;
      offsetOf[pixel] = offset;
      runOf[pixel] = r;
      offset += width;
    }
  });

  return { patch, slots, slotOf, offsetOf, runOf };
}

/** A short human summary: "672 px · 1 gateway · 4 universes (0–3)". */
export function describePatch(compiled: CompiledPatch): string {
  const { patch, slots } = compiled;
  const universes = slots.map((s) => s.universe).sort((a, b) => a - b);
  const range = universes.length === 0 ? "none" : universes.length === 1 ? `${universes[0]}` : `${universes[0]}–${universes[universes.length - 1]}`;
  const g = patch.gateways.length;
  return `${patch.pixelCount} px · ${g} gateway${g === 1 ? "" : "s"} · ${slots.length} universe${slots.length === 1 ? "" : "s"} (${range})`;
}

/** Structural equality, for "has the patch actually changed?" — patches are small, so JSON is fine. */
export function samePatch(a: Patch | null, b: Patch | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
