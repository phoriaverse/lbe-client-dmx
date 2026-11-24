import type { ArtNode } from "./artnet";
import { compilePatch, type Patch } from "./shared/patch";

/** A complete DMX universe, independent of the cable/network carrying it. */
export interface DmxTransport {
  readonly kind: "artnet" | "enttec" | "preview";
  readonly label: string;
  readonly connected: boolean;
  readonly error: string | null;
  readonly sourcePort?: number;
  readonly packetsSent: number;
  readonly failures: number;
  onError?: (context: string, error: Error) => void;
  validatePatch(patch: Patch): string[];
  sendUniverse(host: string, port: number, universe: number, data: Uint8Array, sequence?: number): void;
  knownNodes(): ArtNode[];
  poll(hosts?: readonly { host: string; port: number }[], timeoutMs?: number): Promise<ArtNode[]>;
  close(): void | Promise<void>;
}

export const ENTTEC_HOST = "enttec-usb";

/** One TimoLink TX on Mk2 DMX OUT 1 carries one universe, never a folded multi-universe patch. */
export function enttecPatchProblems(patch: Patch, universe: number): string[] {
  const compiled = compilePatch(patch);
  const problems: string[] = [];
  if (compiled.slots.some((s) => s.gateway.host !== ENTTEC_HOST)) {
    problems.push(`USB output requires the fixture gateway host "${ENTTEC_HOST}"; this patch targets a different rig`);
  }
  if (compiled.slots.some((s) => s.universe !== universe)) {
    problems.push(`ENTTEC DMX OUT 1 is mapped to universe ${universe}; the patch needs another universe`);
  }
  if (compiled.slots.length > 1) problems.push("One TimoLink TX accepts one universe from one gateway; this patch would merge outputs");
  return problems;
}

/** Exercise the same USB patch and preview path without opening any hardware or UDP output. */
export class PreviewTransport implements DmxTransport {
  readonly kind = "preview";
  readonly label = "Preview only — no hardware output";
  readonly connected = false;
  readonly error = null;
  packetsSent = 0;
  failures = 0;
  constructor(private readonly usbUniverse?: number) {}
  validatePatch(patch: Patch) { return this.usbUniverse === undefined ? [] : enttecPatchProblems(patch, this.usbUniverse); }
  sendUniverse() {}
  knownNodes(): ArtNode[] { return []; }
  async poll(): Promise<ArtNode[]> { return []; }
  close() {}
}
