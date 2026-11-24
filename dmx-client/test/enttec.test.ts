import { describe, expect, test } from "bun:test";
import { EnttecDecoder, enttecDmx, enttecMessage } from "../src/enttec-protocol";
import { chooseUsbDevice, EnttecUsb, type UsbConnection } from "../src/enttec";
import { Output } from "../src/output";
import { compilePatch, simplePatch } from "../src/shared/patch";
import { ENTTEC_HOST, enttecPatchProblems, PreviewTransport } from "../src/transport";
import { isLight, parseRig } from "../../dmx-editor/src/model/rig";
import { compileRigPatch } from "../../dmx-editor/src/model/patch";
import { pixelMap } from "../../dmx-editor/src/model/pixels";

const rig = parseRig(await Bun.file(new URL("../../dmx-editor/project/pavotube/rig.json", import.meta.url)).text());
const patch = compileRigPatch(rig);
const wait = () => new Promise((r) => setTimeout(r, 0));

class Widget implements UsbConnection {
  readonly path = "/mock/enttec";
  writes: Uint8Array[] = [];
  closed = false;
  missedQueries = 0;
  gate: Promise<void> | null = null;
  rejectWrites = false;
  private receive: (bytes: Uint8Array) => void = () => {};
  private failure: (error: Error) => void = () => {};
  onData(receive: (bytes: Uint8Array) => void) { this.receive = receive; }
  onFailure(receive: (error: Error) => void) { this.failure = receive; }
  disconnect() { this.failure(new Error("USB unplugged")); }
  async write(bytes: Uint8Array) {
    if (this.rejectWrites) throw new Error("write failed");
    this.writes.push(bytes.slice());
    if (bytes[1] === 3 && this.missedQueries-- <= 0) {
      const reply = enttecMessage(3, new Uint8Array([0, 2, 9, 1, 30]));
      this.receive(new Uint8Array([0, 255]));
      this.receive(reply.slice(0, 3));
      this.receive(reply.slice(3));
    }
    if (this.gate) await this.gate;
  }
  async close() { this.closed = true; }
}

describe("ENTTEC Pro port 1 wire protocol", () => {
  test("full universe has a little-endian 513-byte length and a separate zero start code", () => {
    const data = new Uint8Array(512);
    data[0] = 255;
    data[511] = 42;
    const packet = enttecDmx(data);
    expect(Array.from(packet.slice(0, 6))).toEqual([0x7e, 6, 1, 2, 0, 255]);
    expect(packet.length).toBe(518);
    expect(packet[516]).toBe(42);
    expect(packet[517]).toBe(0xe7);
    expect(() => enttecDmx(new Uint8Array(513))).toThrow();
  });

  test("decoder handles chunk boundaries, multiple frames and malformed headers", () => {
    const decoder = new EnttecDecoder();
    const msg = enttecMessage(3, new Uint8Array([1, 2, 3, 4, 5]));
    expect(decoder.push(new Uint8Array([5, 0x7e, 9, 255, 255]))).toEqual([]);
    expect(decoder.push(msg.slice(0, 5))).toEqual([]);
    expect(decoder.push(new Uint8Array([...msg.slice(5), ...msg]))).toEqual([
      { label: 3, payload: new Uint8Array([1, 2, 3, 4, 5]) },
      { label: 3, payload: new Uint8Array([1, 2, 3, 4, 5]) },
    ]);
  });

  test("queries the widget before output, preserves break/MAB and starts dark without API2", async () => {
    const widget = new Widget();
    const usb = await EnttecUsb.connect(widget, 1, 40);
    expect(widget.writes.map((w) => w[1])).toEqual([3, 4, 6]);
    expect(Array.from(widget.writes[1]!)).toEqual([0x7e, 4, 5, 0, 0, 0, 9, 1, 40, 0xe7]);
    expect(widget.writes[2]!.slice(4, -1).every((v) => v === 0)).toBe(true);
    expect(usb.connected).toBe(true);
    await usb.close();
    expect(widget.closed).toBe(true);
  });

  test("retries a missed identification query before enabling output", async () => {
    const widget = new Widget();
    widget.missedQueries = 1;
    const usb = await EnttecUsb.connect(widget, 1, 40, 100);
    expect(widget.writes.map((w) => w[1])).toEqual([3, 3, 4, 6]);
    await usb.close();
  });

  test("does not output if identification times out", async () => {
    const widget = new Widget();
    widget.missedQueries = Infinity;
    await expect(EnttecUsb.connect(widget, 1, 40, 15)).rejects.toThrow("No ENTTEC Pro reply");
    expect(widget.writes.map((w) => w[1])).toEqual([3, 3]);
    expect(widget.closed).toBe(true);
  });

  test("backpressure keeps one newest snapshot, and shutdown puts black after all colour", async () => {
    const widget = new Widget();
    const usb = await EnttecUsb.connect(widget, 1);
    let release!: () => void;
    widget.gate = new Promise((r) => { release = r; });
    const frame = new Uint8Array(512).fill(10);
    usb.sendUniverse(ENTTEC_HOST, 6454, 1, frame);
    frame.fill(20);
    usb.sendUniverse(ENTTEC_HOST, 6454, 1, frame);
    frame.fill(30);
    usb.sendUniverse(ENTTEC_HOST, 6454, 1, frame);
    frame.fill(99); // queued bytes must not share this reused buffer
    widget.gate = null;
    release();
    await usb.close();
    expect(widget.writes.filter((w) => w[1] === 6).map((w) => w[5])).toEqual([0, 10, 30, 0]);
    expect(widget.closed).toBe(true);
  });

  test("USB write errors and unplugging stop the queue and expose the failure", async () => {
    const widget = new Widget();
    const usb = await EnttecUsb.connect(widget, 1);
    widget.rejectWrites = true;
    usb.sendUniverse(ENTTEC_HOST, 6454, 1, new Uint8Array(512));
    await wait();
    expect(usb.connected).toBe(false);
    expect(usb.error).toBe("write failed");
    expect(usb.failures).toBe(1);
    widget.disconnect();
    expect(usb.error).toBe("USB unplugged");
    await usb.close();
  });

  test("discovery never silently selects unrelated FTDI hardware or an ambiguous adapter", () => {
    const generic = { path: "/dev/tty.usbserial", manufacturer: "FTDI", vendorId: "0403", productId: "6001" };
    expect(() => chooseUsbDevice([generic])).toThrow("No identifiable ENTTEC");
    expect(chooseUsbDevice([generic], generic.path)).toBe(generic.path);
    const enttec = { ...generic, manufacturer: "ENTTEC" };
    expect(chooseUsbDevice([enttec])).toBe(generic.path);
    expect(() => chooseUsbDevice([enttec, { ...enttec, path: "/another" }])).toThrow("Multiple");
  });
});

describe("eight PavoTube II 30XR fixtures", () => {
  test("user addresses use exactly channels 1–384 on universe 1", () => {
    expect(enttecPatchProblems(patch, 1)).toEqual([]);
    expect(patch.pixelCount).toBe(128);
    expect(patch.runs.map((r) => [r.universe, r.channel, r.count, r.order])).toEqual(
      [1, 49, 97, 145, 193, 241, 289, 337].map((channel) => [1, channel, 16, "RGB"]),
    );
    const compiled = compilePatch(patch);
    expect(compiled.slots).toHaveLength(1);
    expect(compiled.slots[0]!.used).toBe(384);
  });

  test("room positions follow the marked atrium layout and retain bottom-to-top pixel order", () => {
    expect(rig.nodes.filter(isLight).map((n) => [n.transform.position[0], n.transform.position[2]])).toEqual([
      [11.7, 1.3], [9, 1.3], [5.9, 1.5], [5.95, 4.45],
      [6.05, 7.05], [8.75, 6.9], [11.4, 7.05], [11.7, 4.25],
    ]);
    expect(rig.room.scale).toBe(1);
    expect(rig.room.position).toEqual([-3.7985, -0.231, 3.363]);
    const map = pixelMap(rig);
    for (let tube = 0; tube < 8; tube++) {
      const bottom = (tube * 16) * 3;
      const top = (tube * 16 + 15) * 3;
      expect(map.positions[bottom + 1]!).toBeLessThan(map.positions[top + 1]!);
      expect(map.positions[top + 1]! - map.positions[bottom + 1]!).toBeCloseTo(1.145 * 15 / 16, 4);
    }
  });

  test("real Output sends bottom/top RGB pixels to the documented ENTTEC channel bytes", async () => {
    const widget = new Widget();
    const usb = await EnttecUsb.connect(widget, 1);
    const output = new Output(usb);
    output.setPatch(patch);
    const frame = new Uint8Array(128 * 3);
    frame.set([255, 0, 0], 0); // tube 1 bottom, red
    frame.set([0, 255, 0], 15 * 3); // tube 1 top, green
    frame.set([0, 0, 255], 16 * 3); // tube 2 bottom, blue
    frame.set([255, 0, 0], 127 * 3); // tube 8 top, red
    output.render(frame);
    await wait();
    const packet = widget.writes.at(-1)!;
    const data = packet.slice(5, -1);
    expect(Array.from(data.slice(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(data.slice(45, 48))).toEqual([0, 255, 0]);
    expect(Array.from(data.slice(48, 51))).toEqual([0, 0, 255]);
    expect(Array.from(data.slice(381, 384))).toEqual([255, 0, 0]);
    expect(data.slice(384).every((v) => v === 0)).toBe(true);
    await output.blackout(2, 1);
    await usb.close();
    expect(widget.writes.at(-1)!.slice(4, -1).every((v) => v === 0)).toBe(true);
  });

  test("a CLEN show or extra universe cannot silently overwrite the USB universe", () => {
    expect(enttecPatchProblems(simplePatch({ host: "2.0.0.100", fixtures: 21, pixelsPerFixture: 32 }), 1).length).toBeGreaterThan(0);
    const preview = new PreviewTransport(1);
    const output = new Output(preview);
    output.setPatch(patch);
    const oversize = structuredClone(patch);
    oversize.runs[7]!.channel = 490;
    expect(() => output.setPatch(oversize)).toThrow("another universe");
    expect(output.patch).toBe(patch);
    expect(preview.connected).toBe(false);
    expect(preview.packetsSent).toBe(0);
  });
});
