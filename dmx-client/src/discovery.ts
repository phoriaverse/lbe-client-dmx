// Finding the control server without anyone typing an IP.
//
// The server broadcasts `{service:"soundspace-popup", wsPort, ips}` to 255.255.255.255:41235 every 2s
// (bun-server/src/discovery.ts). We listen and take `ips[0]` — the same field, in the same order,
// the headsets and screens use, so every client dials the same address.
//
// One thing is different for a lighting machine: it usually has TWO networks, the show LAN and the
// fixture network (the CL-104PS lives on 2.0.0.0/8). The beacon still arrives on the show LAN, and
// `--server host:port` pins it outright if broadcast is blocked or the wrong interface answers.

import dgram from "node:dgram";
import os from "node:os";

const DISCOVERY_PORT = Number(process.env.LBE_DISCOVERY_PORT ?? 41235);
const SERVICE_ID = process.env.LBE_DISCOVERY_SERVICE ?? "soundspace-popup"; // a wire constant the fielded headsets match on; not a directory name
const BEACON_TTL_MS = 8000; // three missed beacons and we stop claiming to know where it is

export interface ServerAddress {
  host: string;
  port: number;
}

function parseAddress(raw: string | undefined): ServerAddress | null {
  if (!raw) return null;
  const [host, port] = raw.trim().replace(/^wss?:\/\//, "").replace(/\/.*$/, "").split(":");
  if (!host) return null;
  return { host, port: Number(port) || 8080 };
}

export class Discovery {
  private readonly beacons = new Map<string, { address: ServerAddress; at: number }>();
  private chosen: string | null = null;
  private warnedAbout = "";
  private readonly pinned: ServerAddress | null;

  constructor(pinned?: string) {
    this.pinned = parseAddress(pinned);
  }

  private fresh(): { key: string; address: ServerAddress; at: number }[] {
    const now = Date.now();
    return [...this.beacons.entries()].filter(([, b]) => now - b.at <= BEACON_TTL_MS).map(([key, b]) => ({ key, ...b }));
  }

  /**
   * Where the control server is, or null if we have not heard from one recently.
   *
   * STICKY on purpose. Two control servers on one LAN is a real situation (a dev machine beside
   * the show Mac), and taking "whichever beaconed last" would hand back a different answer every
   * second. So once a server is chosen it stays chosen for as long as it keeps beaconing; only
   * when it goes quiet does another get picked.
   */
  current(): ServerAddress | null {
    if (this.pinned) return this.pinned;
    const fresh = this.fresh();
    const kept = fresh.find((b) => b.key === this.chosen);
    if (kept) return kept.address;

    // Given a choice, a server on THIS machine wins: the show Mac usually runs both, and a second
    // server elsewhere on the LAN is far more likely to be somebody's dev build than our room.
    const local = new Set(Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((n) => n.address)));
    const next = fresh.sort((a, b) => Number(local.has(b.address.host)) - Number(local.has(a.address.host)) || b.at - a.at)[0];
    if (!next) return null;
    this.chosen = next.key;
    console.log(`[discovery] using control server ${next.key}`);
    return next.address;
  }

  get isPinned() {
    return this.pinned !== null;
  }

  start() {
    if (this.pinned) {
      console.log(`[discovery] using pinned server ${this.pinned.host}:${this.pinned.port} — not listening for beacons`);
      return;
    }

    // reuseAddr: the Unity client and video-client bind this same port on a dev machine.
    const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    udp.on("error", (err) => console.warn(`[discovery] ${err.message}`));
    udp.on("message", (buf) => {
      let payload: { service?: string; wsPort?: number; ips?: string[] };
      try {
        payload = JSON.parse(buf.toString());
      } catch {
        return; // not ours
      }
      if (payload.service !== SERVICE_ID || !payload.wsPort || !payload.ips?.length) return;

      const address: ServerAddress = { host: payload.ips[0]!, port: payload.wsPort };
      this.beacons.set(`${address.host}:${address.port}`, { address, at: Date.now() });

      // More than one server answering is worth saying once — it decides which room we are in.
      const keys = this.fresh().map((b) => b.key).sort().join(", ");
      if (keys.includes(",") && keys !== this.warnedAbout) {
        this.warnedAbout = keys;
        console.warn(`[discovery] more than one control server on this network: ${keys}. Preferring one on this machine, else the first heard; pin one with --server host:port.`);
      }
    });
    udp.bind(DISCOVERY_PORT, () => console.log(`[discovery] listening for the control server on udp/${DISCOVERY_PORT}`));
  }
}
