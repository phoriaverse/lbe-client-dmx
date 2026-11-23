import { afterEach, describe, expect, test } from "bun:test";
import { ArtNetSocket, createDmxPacket, parseDmx } from "../src/artnet";
import { Output, buildDriveTable } from "../src/output";
import { type Patch, chainRuns, simplePatch } from "../src/shared/patch";
import { encodeSample } from "../src/shared/show-file";
import { type SimGateway, simPixel, startSimGateway } from "../src/tools/sim-gateway";

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("drive tables", () => {
  const table = (over: Partial<Parameters<typeof buildDriveTable>[0]> = {}) => buildDriveTable({ bits: 8, transfer: 2.2, gamma: 2.2, gain: 1, level: 1, ...over });

  test("a linear-PWM fixture (gamma 2.2) is driven with linear light", () => {
    const t = table();
    for (const light of [0.01, 0.1, 0.25, 0.5, 0.9]) {
      expect(Math.abs(t[encodeSample(light, 8)]! - light * 255)).toBeLessThanOrEqual(2.5);
    }
    expect(t[0]).toBe(0);
    expect(t[255]).toBe(255);
  });

  test("a fixture with its own curve (gamma 1) is handed the perceptual level", () => {
    const t = table({ gamma: 1 });
    expect(t[128]).toBe(128);
    expect(t[64]).toBe(64);
  });

  test("master and cap scale LIGHT, so 50% halves the drive of a linear fixture", () => {
    const full = table();
    const half = table({ level: 0.5 });
    expect(half[255]).toBe(128);
    expect(Math.abs(half[200]! - full[200]! / 2)).toBeLessThanOrEqual(1);
    expect(table({ level: 0 }).every((v) => v === 0)).toBe(true);
  });

  test("gain trims one channel and cannot push past full", () => {
    expect(table({ gain: 0.5 })[255]).toBe(128);
    expect(table({ gain: 4 })[255]).toBe(255);
  });

  test("16-bit shows get a 65536-entry table with the same end points", () => {
    const t = table({ bits: 16 });
    expect(t.length).toBe(65536);
    expect(t[0]).toBe(0);
    expect(t[65535]).toBe(255);
    expect(Math.abs(t[encodeSample(0.5, 16)]! - 127.5)).toBeLessThanOrEqual(1);
  });
});

describe("Art-Net packets", () => {
  test("ArtDmx header is byte-exact", () => {
    const p = createDmxPacket(0x0123);
    expect(Array.from(p.bytes.subarray(0, 18))).toEqual([
      0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00, // "Art-Net\0"
      0x00, 0x50, // OpDmx, little-endian
      0x00, 14, // protocol version
      0, 0, // sequence, physical
      0x23, 0x01, // SubUni, Net
      0x02, 0x00, // length 512, big-endian
    ]);
    expect(p.bytes.length).toBe(530);
    p.data[5] = 99;
    expect(parseDmx(p.bytes)).toMatchObject({ portAddress: 0x0123, sequence: 0 });
    expect(parseDmx(p.bytes)!.data[5]).toBe(99);
  });
});

describe("output → gateway", () => {
  let sim: SimGateway | null = null;
  let socket: ArtNetSocket | null = null;
  afterEach(() => {
    sim?.close();
    socket?.close();
    sim = socket = null;
  });

  // Tests send from an ephemeral port so they can run while a real client holds 6454; the
  // simulator's source-port rule is exercised separately below.
  const rig = async (requireSourcePort: number | null = null) => {
    sim = await startSimGateway({ port: 0, requireSourcePort });
    socket = await ArtNetSocket.open(0);
    const output = new Output(socket);
    const patch = simplePatch({ host: "127.0.0.1", port: sim.port, fixtures: 21, pixelsPerFixture: 32 });
    output.setPatch(patch);
    return { sim, socket, output, patch };
  };

  test("pixels land in GRB order on the right universe and channel", async () => {
    const { sim, output } = await rig();
    const frame = new Uint8Array(672 * 3);
    const mark = (p: number, r: number, g: number, b: number) => frame.set([r, g, b], p * 3);
    mark(0, 255, 0, 0); // first pixel, red
    mark(169, 0, 255, 0); // last pixel of universe 0, green
    mark(170, 0, 0, 255); // first pixel of universe 1, blue
    mark(671, 255, 255, 255); // last pixel of the chain
    output.render(frame);
    await settle();

    expect(sim.universes.size).toBe(4);
    expect(Array.from(sim.universes.get(0)!.subarray(0, 3))).toEqual([0, 255, 0]); // G R B on the wire
    expect(simPixel(sim, 0)).toEqual([255, 0, 0]);
    expect(simPixel(sim, 169)).toEqual([0, 255, 0]);
    expect(Array.from(sim.universes.get(0)!.subarray(507, 512))).toEqual([255, 0, 0, 0, 0]);
    expect(simPixel(sim, 170)).toEqual([0, 0, 255]);
    expect(simPixel(sim, 671)).toEqual([255, 255, 255]);
    expect(simPixel(sim, 1)).toEqual([0, 0, 0]);
  });

  test("a null frame is black on every universe", async () => {
    const { sim, output } = await rig();
    output.render(new Uint8Array(672 * 3).fill(200));
    await settle();
    expect(simPixel(sim, 300)[0]).toBeGreaterThan(0);
    output.render(null);
    await settle();
    for (const data of sim.universes.values()) expect(data.every((v) => v === 0)).toBe(true);
  });

  test("master × cap dims the wire without touching the frame", async () => {
    const { sim, output } = await rig();
    output.setLevels({ master: 0.5, cap: 0.5 });
    output.render(new Uint8Array(672 * 3).fill(255));
    await settle();
    expect(simPixel(sim, 10)).toEqual([64, 64, 64]);
    expect(Array.from(output.lastDriveLevels.subarray(0, 3))).toEqual([64, 64, 64]);
  });

  test("16-bit frames render the same light as their 8-bit equivalents", async () => {
    const { sim, output } = await rig();
    const frame = new Uint16Array(672 * 3).fill(encodeSample(0.25, 16));
    output.render(frame);
    await settle();
    expect(Math.abs(simPixel(sim, 5)[1] - 64)).toBeLessThanOrEqual(1);
  });

  test("a universe that leaves the patch is blacked out, not left holding its last frame", async () => {
    const { sim, output, patch } = await rig();
    output.render(new Uint8Array(672 * 3).fill(255));
    await settle();
    expect(simPixel(sim, 600)[0]).toBe(255);

    // Shrink to 5 tubes: universes 1–3 are no longer addressed.
    const small: Patch = { pixelCount: 160, gateways: patch.gateways, runs: chainRuns("gw1", Array.from({ length: 5 }, () => ({ count: 32, order: "GRB" as const, gamma: 2.2 }))) };
    output.setPatch(small);
    output.render(new Uint8Array(160 * 3).fill(255));
    await settle();
    expect(simPixel(sim, 100)[0]).toBe(255);
    expect(simPixel(sim, 600)).toEqual([0, 0, 0]);
    expect(sim.universes.get(3)!.every((v) => v === 0)).toBe(true);
  });

  test("RGBW moves the shared white onto the white channel", async () => {
    const { sim, output, patch } = await rig();
    output.setPatch({ pixelCount: 2, gateways: patch.gateways, runs: chainRuns("gw1", [{ count: 2, order: "GRBW", gamma: 2.2 }]) });
    output.render(new Uint8Array([255, 255, 255, 255, 0, 0]));
    await settle();
    expect(Array.from(sim.universes.get(0)!.subarray(0, 8))).toEqual([0, 0, 0, 255, 0, 255, 0, 0]);
  });

  test("the simulated gateway drops data from the wrong source port, like the real one", async () => {
    const { sim, output, socket } = await rig(6454);
    output.render(new Uint8Array(672 * 3).fill(255));
    await settle();
    expect(sim.accepted).toBe(0);
    expect(sim.dropped).toBe(4);
    // …while still answering a poll, which is what made the real fault so hard to find.
    const nodes = await socket.poll([{ host: "127.0.0.1", port: sim.port }], 150);
    expect(nodes.some((n) => n.shortName === "SIM-ArtNet")).toBe(true);
  });
});
