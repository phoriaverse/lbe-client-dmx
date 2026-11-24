import type { ArtNode } from "./artnet";
import { EnttecDecoder, enttecDmx, enttecMessage } from "./enttec-protocol";
import type { Patch } from "./shared/patch";
import { ENTTEC_HOST, enttecPatchProblems, type DmxTransport } from "./transport";
import { listUsbDevices, openSerial } from "./serial-connection";
export { listUsbDevices } from "./serial-connection";

export interface UsbConnection {
  readonly path: string;
  write(bytes: Uint8Array): Promise<void>;
  onData(receive: (bytes: Uint8Array) => void): void;
  onFailure(receive: (error: Error) => void): void;
  close(): Promise<void>;
}

/** Never choose an arbitrary FTDI adapter: FTDI chips also appear in unrelated equipment. */
export function chooseUsbDevice(devices: Awaited<ReturnType<typeof listUsbDevices>>, requested?: string): string {
  if (requested) {
    if (!devices.some((d) => d.path === requested)) throw new Error(`USB device ${requested} is not present. Run bun run usb:list.`);
    return requested;
  }
  const candidates = devices.filter((d) => /enttec/i.test(`${d.manufacturer ?? ""} ${d.pnpId ?? ""}`));
  if (candidates.length !== 1) {
    throw new Error(`${candidates.length ? "Multiple ENTTEC devices found" : "No identifiable ENTTEC USB device found"}. Run bun run usb:list and select --usb-device <path>. For the editor without hardware use --output preview.`);
  }
  return candidates[0]!.path;
}

async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}

/** Mk2 DMX OUT 1 via the public Pro/API1 protocol. OUT 2 and proprietary API2 are not used. */
export class EnttecUsb implements DmxTransport {
  readonly kind = "enttec";
  readonly label: string;
  connected = false;
  error: string | null = null;
  packetsSent = 0;
  failures = 0;
  onError?: (context: string, error: Error) => void;
  private pending: Uint8Array | null = null;
  private sending: Promise<void> | null = null;
  private closing = false;
  private readonly decoder = new EnttecDecoder();
  private parameters: ((payload: Uint8Array) => void) | null = null;
  private rejectParameters: ((error: Error) => void) | null = null;

  private constructor(private readonly connection: UsbConnection, private readonly universe: number) {
    this.label = `ENTTEC USB Pro Mk2 · DMX OUT 1 · ${connection.path}`;
    connection.onData((chunk) => {
      for (const msg of this.decoder.push(chunk)) {
        if (msg.label === 3 && msg.payload.length >= 5) this.parameters?.(msg.payload);
      }
    });
    connection.onFailure((error) => this.fail(error));
  }

  static async open(device: string | undefined, universe: number, fps: number): Promise<EnttecUsb> {
    const path = chooseUsbDevice(await listUsbDevices(), device);
    return this.connect(await openSerial(path), universe, fps);
  }

  /** Also used by the protocol emulator tests; production opens the VCP exclusively above. */
  static async connect(connection: UsbConnection, universe = 0, fps = 40, timeoutMs = 2000): Promise<EnttecUsb> {
    const usb = new EnttecUsb(connection, universe);
    try {
      if (!Number.isInteger(universe) || universe < 0 || universe > 32767) throw new Error("Invalid ENTTEC universe");
      if (!Number.isInteger(fps) || fps < 1 || fps > 40) throw new Error("ENTTEC output rate must be a whole number from 1 to 40 fps");
      // Arm before requesting. A valid reply proves this path speaks the Pro protocol.
      const response = new Promise<Uint8Array>((resolve, reject) => { usb.parameters = resolve; usb.rejectParameters = reject; });
      const waiting = within(response, timeoutMs, "No ENTTEC Pro reply. Check the VCP driver and device path, close other lighting apps, and power-cycle the Mk2 if another app selected API2.");
      const [, params] = await Promise.all([
        within(connection.write(enttecMessage(3, new Uint8Array([0, 0]))), timeoutMs, "ENTTEC parameter request timed out"),
        waiting,
      ]);
      if (usb.error) throw new Error(usb.error);
      // Preserve the widget's break/MAB; set the requested refresh rate, no user-data change.
      await within(connection.write(enttecMessage(4, new Uint8Array([0, 0, params[2]!, params[3]!, fps]))), timeoutMs, "ENTTEC configuration timed out");
      await within(connection.write(enttecDmx(new Uint8Array(512))), timeoutMs, "ENTTEC initial blackout timed out");
      if (usb.error) throw new Error(usb.error);
      usb.packetsSent = 1;
      usb.connected = true;
      return usb;
    } catch (error) {
      await connection.close().catch(() => {});
      throw error;
    } finally {
      usb.parameters = null;
      usb.rejectParameters = null;
    }
  }

  validatePatch(patch: Patch) { return enttecPatchProblems(patch, this.universe); }
  knownNodes(): ArtNode[] { return []; }
  async poll(): Promise<ArtNode[]> { return []; }

  sendUniverse(host: string, _port: number, universe: number, data: Uint8Array) {
    if (host !== ENTTEC_HOST || universe !== this.universe) throw new Error("Patch does not match the configured ENTTEC output");
    if (!this.connected || this.closing) return;
    // Copy now: Output reuses its buffer next tick. Coalesce to the newest frame under backpressure.
    this.pending = enttecDmx(data);
    if (!this.sending) this.sending = this.pump().finally(() => { this.sending = null; });
  }

  private async pump() {
    while (this.pending && this.connected) {
      const frame = this.pending;
      this.pending = null;
      try {
        await within(this.connection.write(frame), 2000, "ENTTEC USB write stalled; output stopped");
        this.packetsSent += 1;
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    }
  }

  private fail(error: Error) {
    this.rejectParameters?.(error);
    this.failures += 1;
    this.error = error.message;
    this.connected = false;
    this.pending = null;
    this.onError?.(this.label, error);
    console.error(`[enttec] ${error.message}`);
  }

  async close() {
    this.closing = true;
    try {
      if (this.sending) await this.sending;
      // This is after every queued frame and before releasing USB, so no stale colour follows it.
      if (this.connected) await within(this.connection.write(enttecDmx(new Uint8Array(512))), 2000, "ENTTEC final blackout timed out");
    } finally {
      this.connected = false;
      await this.connection.close();
    }
  }
}
