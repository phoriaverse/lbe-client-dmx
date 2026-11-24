// Art-Net on the wire: packet layout, and the one UDP socket this process sends from.
//
// Two facts about the hardware shape this file, both found on the bench and neither in a manual:
//
//  1. THE SOURCE PORT MUST BE 6454. The CL-104PS silently drops ArtDmx from any other source port —
//     its display blinks "No Signal" while it still happily answers ArtPoll. So the socket is BOUND
//     to 6454, not merely sending to it.
//
//  2. That bind is also the lock. Only one process can hold UDP 6454, so only one program can ever
//     be driving the fixtures. We bind WITHOUT SO_REUSEADDR on purpose: a second sender must fail
//     loudly at startup rather than interleave frames with the first and make the rig flicker.
//
// Kept to node:dgram (not Bun.udpSocket) for the same reason bun-server's beacon is: a failed send
// reports through a callback instead of throwing inside a timer and taking the process down.

import dgram from "node:dgram";
import os from "node:os";
import { ARTNET_PORT, DMX_UNIVERSE_SIZE, type Patch } from "./shared/patch";

const ARTNET_ID = [0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]; // "Art-Net\0"
export const OP_POLL = 0x2000;
export const OP_POLL_REPLY = 0x2100;
export const OP_DMX = 0x5000;
const PROTOCOL_VERSION = 14;
export const DMX_HEADER_SIZE = 18;

/**
 * A reusable ArtDmx packet for one universe. The 512 data bytes live inside the packet buffer, so
 * rendering a frame writes straight into what gets sent — no per-frame allocation or copy.
 */
export interface DmxPacket {
  bytes: Uint8Array;
  /** View of the 512 channel bytes inside `bytes`. */
  data: Uint8Array;
}

export function createDmxPacket(portAddress: number, length = DMX_UNIVERSE_SIZE): DmxPacket {
  // Length must be even and 2–512. Always-full universes are the default: the bench found values
  // past the last pixel harmless, and a constant length is one less thing for a fussy node to dislike.
  const len = Math.min(DMX_UNIVERSE_SIZE, Math.max(2, length + (length % 2)));
  const bytes = new Uint8Array(DMX_HEADER_SIZE + len);
  bytes.set(ARTNET_ID, 0);
  bytes[8] = OP_DMX & 0xff; // opcode, little-endian
  bytes[9] = OP_DMX >> 8;
  bytes[10] = 0; // protocol version, big-endian
  bytes[11] = PROTOCOL_VERSION;
  bytes[12] = 0; // sequence: 0 = "not sequenced". See setSequence.
  bytes[13] = 0; // physical port, informational
  bytes[14] = portAddress & 0xff; // SubUni: subnet (high nibble) + universe (low nibble)
  bytes[15] = (portAddress >> 8) & 0x7f; // Net
  bytes[16] = len >> 8; // length, big-endian
  bytes[17] = len & 0xff;
  return { bytes, data: bytes.subarray(DMX_HEADER_SIZE) };
}

/** Art-Net sequence numbers run 1–255 and wrap; 0 means the sender does not sequence. */
export function setSequence(packet: DmxPacket, sequence: number) {
  packet.bytes[12] = sequence;
}

export function createPollPacket(): Uint8Array {
  const bytes = new Uint8Array(14);
  bytes.set(ARTNET_ID, 0);
  bytes[8] = OP_POLL & 0xff;
  bytes[9] = OP_POLL >> 8;
  bytes[10] = 0;
  bytes[11] = PROTOCOL_VERSION;
  bytes[12] = 0; // TalkToMe: reply only when polled, no diagnostics
  bytes[13] = 0; // priority
  return bytes;
}

export function opcodeOf(bytes: Uint8Array): number | null {
  if (bytes.length < 10) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== ARTNET_ID[i]) return null;
  return bytes[8]! | (bytes[9]! << 8);
}

export interface ParsedDmx {
  sequence: number;
  portAddress: number;
  data: Uint8Array;
}

export function parseDmx(bytes: Uint8Array): ParsedDmx | null {
  if (opcodeOf(bytes) !== OP_DMX || bytes.length < DMX_HEADER_SIZE) return null;
  const length = (bytes[16]! << 8) | bytes[17]!;
  if (length < 2 || length > DMX_UNIVERSE_SIZE || bytes.length < DMX_HEADER_SIZE + length) return null;
  return {
    sequence: bytes[12]!,
    portAddress: bytes[14]! | ((bytes[15]! & 0x7f) << 8),
    data: bytes.subarray(DMX_HEADER_SIZE, DMX_HEADER_SIZE + length),
  };
}

/** A node that answered ArtPoll. */
export interface ArtNode {
  ip: string;
  shortName: string;
  longName: string;
  /** Number of ports the node claims. */
  ports: number;
  /** Port-addresses of its outputs, as it reports them. */
  universes: number[];
  /** Where the reply actually came from — the address to trust if the node misreports its own IP. */
  from: string;
  seenAt: number;
}

const cString = (bytes: Uint8Array, start: number, length: number) => {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end)).trim();
};

export function parsePollReply(bytes: Uint8Array, from: string): ArtNode | null {
  if (opcodeOf(bytes) !== OP_POLL_REPLY || bytes.length < 207) return null;
  const net = bytes[18]! & 0x7f;
  const subnet = bytes[19]! & 0x0f;
  const ports = Math.min(4, (bytes[172]! << 8) | bytes[173]!);
  const universes: number[] = [];
  for (let p = 0; p < ports; p++) universes.push((net << 8) | (subnet << 4) | (bytes[190 + p]! & 0x0f));
  return {
    ip: `${bytes[10]}.${bytes[11]}.${bytes[12]}.${bytes[13]}`,
    shortName: cString(bytes, 26, 18),
    longName: cString(bytes, 44, 64),
    ports,
    universes,
    from,
    seenAt: Date.now(),
  };
}

/** Build an ArtPollReply — only the simulated gateway needs this, but the layout belongs here. */
export function createPollReply(opts: { ip: string; shortName: string; longName: string; universes: number[] }): Uint8Array {
  const bytes = new Uint8Array(239);
  bytes.set(ARTNET_ID, 0);
  bytes[8] = OP_POLL_REPLY & 0xff;
  bytes[9] = OP_POLL_REPLY >> 8;
  opts.ip.split(".").forEach((part, i) => (bytes[10 + i] = Number(part)));
  bytes[14] = ARTNET_PORT & 0xff;
  bytes[15] = ARTNET_PORT >> 8;
  const first = opts.universes[0] ?? 0;
  bytes[18] = (first >> 8) & 0x7f;
  bytes[19] = (first >> 4) & 0x0f;
  const enc = new TextEncoder();
  bytes.set(enc.encode(opts.shortName).subarray(0, 17), 26);
  bytes.set(enc.encode(opts.longName).subarray(0, 63), 44);
  const ports = Math.min(4, opts.universes.length);
  bytes[172] = 0;
  bytes[173] = ports;
  for (let p = 0; p < ports; p++) {
    bytes[174 + p] = 0x80; // port type: can output DMX
    bytes[190 + p] = opts.universes[p]! & 0x0f;
  }
  return bytes;
}

/** Directed broadcast address of every IPv4 interface — where an ArtPoll has to go to be heard. */
export function broadcastAddresses(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      // A self-assigned 169.254 address means the interface has no real network behind it (macOS
      // gives a cabled-but-unconfigured port one). Broadcasting there only produces send errors.
      if (net.address.startsWith("169.254.")) continue;
      const addr = net.address.split(".").map(Number);
      const mask = net.netmask.split(".").map(Number);
      out.add(addr.map((a, i) => (a & mask[i]!) | (~mask[i]! & 0xff)).join("."));
    }
  }
  return [...out];
}

export class ArtNetSocket {
  readonly kind = "artnet" as const;
  readonly label = "Art-Net";
  connected = true;
  get error(): string | null { return this.lastSendError || null; }
  validatePatch(patch: Patch): string[] {
    return patch.gateways.some((g) => g.host === "enttec-usb") ? ["This is a USB fixture patch; select --output enttec or preview"] : [];
  }
  private readonly nodes = new Map<string, ArtNode>();
  private sendFailures = 0;
  private lastSendError = "";
  packetsSent = 0;

  private constructor(
    private readonly udp: dgram.Socket,
    readonly sourcePort: number,
  ) {
    udp.on("message", (buf, rinfo) => {
      const node = parsePollReply(buf, rinfo.address);
      if (node) this.nodes.set(node.from, node);
    });
    udp.on("error", (err) => console.warn(`[artnet] socket error: ${err.message}`));
  }

  /**
   * Bind the sending socket. `sourcePort` defaults to 6454 and should stay there for real hardware;
   * tests pass 0 (ephemeral) so they can run beside a live client.
   */
  static open(sourcePort = ARTNET_PORT): Promise<ArtNetSocket> {
    return new Promise((resolve, reject) => {
      const udp = dgram.createSocket({ type: "udp4", reuseAddr: false });
      const onError = (err: NodeJS.ErrnoException) => {
        udp.close();
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `UDP port ${sourcePort} is already in use. Only one program can drive the fixtures at a time — ` +
                `another lighting-client, or a DMX tool, is holding it. Quit that and start again.`,
            ),
          );
        } else {
          reject(err);
        }
      };
      udp.once("error", onError);
      udp.bind(sourcePort, () => {
        udp.off("error", onError);
        try {
          udp.setBroadcast(true); // needed for ArtPoll to a broadcast address
        } catch {
          // Unicast still works without it; poll() falls back to the gateways it was told about.
        }
        resolve(new ArtNetSocket(udp, udp.address().port));
      });
    });
  }

  sendDmx(host: string, port: number, packet: DmxPacket) {
    this.send(packet.bytes, host, port);
  }

  sendUniverse(host: string, port: number, universe: number, data: Uint8Array, sequence = 0) {
    const packet = createDmxPacket(universe);
    packet.data.set(data);
    setSequence(packet, sequence);
    this.sendDmx(host, port, packet);
  }

  private send(bytes: Uint8Array, host: string, port: number, quiet = false) {
    this.packetsSent += 1;
    this.udp.send(bytes, port, host, (err) => {
      // A poll that cannot be sent is not a fault — it is an interface with nobody on it.
      if (!err || quiet) return;
      this.sendFailures += 1;
      // One line per distinct failure, not one per packet: at 160 packets a second a dead route
      // would otherwise bury the log that says why.
      if (err.message !== this.lastSendError) {
        this.lastSendError = err.message;
        console.warn(`[artnet] send to ${host}:${port} failed: ${err.message}`);
      }
    });
  }

  /**
   * Ask who is out there. Polls every interface's broadcast address and, because broadcast is the
   * first thing a locked-down network blocks, each named host directly as well.
   */
  async poll(hosts: readonly { host: string; port: number }[] = [], timeoutMs = 600): Promise<ArtNode[]> {
    const packet = createPollPacket();
    for (const address of broadcastAddresses()) this.send(packet, address, ARTNET_PORT, true);
    for (const { host, port } of hosts) this.send(packet, host, port, true);
    await new Promise((r) => setTimeout(r, timeoutMs));
    return this.knownNodes();
  }

  /** Every node that has answered a poll, most recently seen first. */
  knownNodes(): ArtNode[] {
    return [...this.nodes.values()].sort((a, b) => b.seenAt - a.seenAt);
  }

  get failures() {
    return this.sendFailures;
  }

  close() {
    this.connected = false;
    try {
      this.udp.close();
    } catch {
      // already closed
    }
  }
}
