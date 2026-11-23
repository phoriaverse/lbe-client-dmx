// Frame → wire. The only place colour turns into DMX bytes.
//
// A frame arrives as show samples (see shared/show-file.ts): linear light, power-encoded, 8 or 16
// bit, R G B per pixel in frame order. For every pixel this does, in order:
//
//   sample ──decode──▶ linear light ──× master × cap × gain──▶ ──fixture curve──▶ 8-bit drive level
//
// and writes the result into the right universe at the right channel in the fixture's colour order.
//
// The whole chain is collapsed into lookup tables, one per (fixture curve, channel gain), rebuilt
// only when the patch or a level changes — so the per-frame cost is three table reads per pixel.
//
// ON THE FIXTURE CURVE. A patch run's `gamma` is the exponent from a *perceptual* level to that
// fixture's drive level. The CL05 tubes are linear PWM (bench: 0→31 is a bigger visible change than
// 31→255), so their gamma is 2.2 and the drive level comes out equal to linear light — which is
// correct, a linear device wants linear light. A fixture with its own dimming curve would say 1.0
// and receive the perceptual level instead. Formally: drive = linear ^ (gamma / 2.2).
//
// MASTER AND CAP are applied in linear light, so 0.5 means half the light (and about half the
// power), not "half way down a fader". They multiply: cap is what 100% means on this site, master
// moves underneath it. Neither needs a re-bake.

import { type ArtNetSocket, type DmxPacket, createDmxPacket, setSequence } from "./artnet";
import { ARTNET_PORT, type CompiledPatch, type Patch, compilePatch, describePatch, samePatch } from "./shared/patch";

/** The perceptual reference exponent the fixture `gamma` is defined against. */
const PERCEPTUAL_GAMMA = 2.2;

/** How many zero frames a universe gets when it leaves the patch, or at shutdown. */
const BLACKOUT_REPEATS = 10;

export interface OutputLevels {
  /** Operator dimmer, 0–1, linear light. */
  master: number;
  /** Site ceiling, 0–1, linear light. Drive never exceeds what `cap` allows. */
  cap: number;
}

type Frame = Uint8Array | Uint16Array;

interface RunTables {
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  /** Byte position of each colour within the pixel's channels; w is -1 for a 3-channel fixture. */
  posR: number;
  posG: number;
  posB: number;
  posW: number;
}

interface Retiring {
  host: string;
  port: number;
  universe: number;
  packet: DmxPacket;
  remaining: number;
}

/** Build the sample → drive table for one channel. Exported for the tests. */
export function buildDriveTable(opts: { bits: 8 | 16; transfer: number; gamma: number; gain: number; level: number }): Uint8Array {
  const size = opts.bits === 16 ? 65536 : 256;
  const max = size - 1;
  const table = new Uint8Array(size);
  const scale = Math.max(0, opts.gain) * Math.max(0, opts.level);
  const curve = opts.gamma / PERCEPTUAL_GAMMA;
  for (let v = 1; v < size; v++) {
    const linear = Math.min(1, Math.pow(v / max, opts.transfer) * scale);
    table[v] = Math.round(Math.pow(linear, curve) * 255);
  }
  return table; // table[0] stays 0: black is always exactly black
}

export class Output {
  private compiled: CompiledPatch | null = null;
  private packets: DmxPacket[] = [];
  private sequences: number[] = [];
  private tables: RunTables[] = [];
  private tablesKey = "";
  private retiring: Retiring[] = [];
  private levels: OutputLevels = { master: 1, cap: 1 };
  /** The last frame as drive levels, R G B per pixel in frame order — for the control page. */
  private monitor = new Uint8Array(0);

  framesRendered = 0;

  constructor(
    private readonly socket: ArtNetSocket,
    /** Number ArtDmx packets 1–255. Off by default: the bench tools did not, and the CL-104PS is fussy. */
    private readonly sequenced = false,
  ) {}

  get patch(): Patch | null {
    return this.compiled?.patch ?? null;
  }

  get description(): string {
    return this.compiled ? describePatch(this.compiled) : "no patch";
  }

  setLevels(levels: OutputLevels) {
    this.levels = { master: clamp01(levels.master), cap: clamp01(levels.cap) };
    this.tablesKey = ""; // force a rebuild on the next frame
  }

  /**
   * Switch to a new patch. Universes that were being driven and are not in the new patch are sent
   * zeros for a while — the gateway holds its last frame forever, so a universe we simply stop
   * addressing would stay lit with whatever it last showed.
   */
  setPatch(patch: Patch | null) {
    if (samePatch(patch, this.patch)) return;
    const next = patch ? compilePatch(patch) : null;

    const stillDriven = new Set((next?.slots ?? []).map((s) => wireKey(s.gateway.host, s.gateway.port, s.universe)));
    // A universe that is coming BACK must stop being zeroed, or the tail of its blackout would
    // interleave with live frames and flicker.
    this.retiring = this.retiring.filter((r) => !stillDriven.has(wireKey(r.host, r.port, r.universe)));
    this.compiled?.slots.forEach((slot, i) => {
      const key = wireKey(slot.gateway.host, slot.gateway.port, slot.universe);
      if (stillDriven.has(key)) return;
      const packet = this.packets[i]!;
      packet.data.fill(0);
      this.retiring.push({
        host: slot.gateway.host,
        port: slot.gateway.port ?? ARTNET_PORT,
        universe: slot.universe,
        packet,
        remaining: BLACKOUT_REPEATS,
      });
    });

    this.compiled = next;
    this.packets = (next?.slots ?? []).map((s) => createDmxPacket(s.universe));
    this.sequences = this.packets.map(() => 0);
    this.monitor = new Uint8Array((next?.patch.pixelCount ?? 0) * 3);
    this.tablesKey = "";
  }

  private ensureTables(bits: 8 | 16, transfer: number) {
    const level = this.levels.master * this.levels.cap;
    const key = `${bits}|${transfer}|${level}`;
    if (key === this.tablesKey || !this.compiled) return;
    this.tablesKey = key;

    // Many runs share a curve (21 identical tubes ⇒ one table), so build each distinct one once.
    const cache = new Map<string, Uint8Array>();
    const table = (gamma: number, gain: number) => {
      const k = `${gamma}|${gain}`;
      let t = cache.get(k);
      if (!t) cache.set(k, (t = buildDriveTable({ bits, transfer, gamma, gain, level })));
      return t;
    };

    this.tables = this.compiled.patch.runs.map((run) => {
      const [gr, gg, gb] = run.gain ?? [1, 1, 1];
      return {
        r: table(run.gamma, gr),
        g: table(run.gamma, gg),
        b: table(run.gamma, gb),
        posR: run.order.indexOf("R"),
        posG: run.order.indexOf("G"),
        posB: run.order.indexOf("B"),
        posW: run.order.indexOf("W"),
      };
    });
  }

  /**
   * Render one frame and send every universe. `frame` null means black. `transfer` is the frame's
   * encoding exponent (a show's header carries it).
   *
   * Every universe is sent on every call, changed or not. The gateway holds its last frame, so a
   * steady stream is not a keep-alive nicety — it is what makes a dropped packet self-heal one
   * frame later instead of leaving a stale universe on the wall.
   */
  render(frame: Frame | null, transfer = PERCEPTUAL_GAMMA) {
    const compiled = this.compiled;
    if (compiled) {
      for (const packet of this.packets) packet.data.fill(0);
      this.monitor.fill(0);

      if (frame) {
        const bits = frame instanceof Uint16Array ? 16 : 8;
        this.ensureTables(bits, transfer);
        const { slotOf, offsetOf, runOf } = compiled;
        // A frame shorter than the patch (a mismatched preview, say) lights what it covers.
        const pixels = Math.min(compiled.patch.pixelCount, Math.floor(frame.length / 3));
        const monitor = this.monitor;

        for (let p = 0; p < pixels; p++) {
          const s = slotOf[p]!;
          if (s < 0) continue;
          const t = this.tables[runOf[p]!]!;
          const i = p * 3;
          let r = t.r[frame[i]!]!;
          let g = t.g[frame[i + 1]!]!;
          let b = t.b[frame[i + 2]!]!;
          monitor[i] = r;
          monitor[i + 1] = g;
          monitor[i + 2] = b;

          const data = this.packets[s]!.data;
          const o = offsetOf[p]!;
          if (t.posW >= 0) {
            // RGBW: move the shared white component onto the white emitter.
            const w = Math.min(r, g, b);
            r -= w;
            g -= w;
            b -= w;
            data[o + t.posW] = w;
          }
          data[o + t.posR] = r;
          data[o + t.posG] = g;
          data[o + t.posB] = b;
        }
      }

      compiled.slots.forEach((slot, i) => {
        const packet = this.packets[i]!;
        if (this.sequenced) {
          const next = (this.sequences[i]! % 255) + 1;
          this.sequences[i] = next;
          setSequence(packet, next);
        }
        this.socket.sendDmx(slot.gateway.host, slot.gateway.port ?? ARTNET_PORT, packet);
      });
    }

    if (this.retiring.length) {
      for (const r of this.retiring) {
        this.socket.sendDmx(r.host, r.port, r.packet);
        r.remaining -= 1;
      }
      this.retiring = this.retiring.filter((r) => r.remaining > 0);
    }

    this.framesRendered += 1;
  }

  /** The last frame's drive levels (R G B per pixel, frame order). A live view, not a copy. */
  get lastDriveLevels(): Uint8Array {
    return this.monitor;
  }

  /**
   * Send black repeatedly, with gaps. A single blackout packet is not reliably applied by the
   * CL-104PS (bench finding), and this is the last thing the process does before it exits.
   */
  async blackout(repeats = BLACKOUT_REPEATS, gapMs = 20) {
    for (let i = 0; i < repeats; i++) {
      this.render(null);
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const wireKey = (host: string, port: number | undefined, universe: number) => `${host}:${port ?? ARTNET_PORT}/${universe}`;
