// `bun run sim` — a stand-in for the CL-104PS, for working without the rig plugged in.
//
// It listens for Art-Net, decodes ArtDmx into universes, answers ArtPoll, and prints what a row of
// GRB tubes would be showing. It also reproduces the one behaviour of the real unit that is easy to
// get wrong and impossible to see: it DROPS data that does not come from source port 6454, while
// still answering polls.
//
// It listens on 6455, not 6454 — the client must hold 6454 as its source port, and two sockets
// cannot share it on one machine. Point the client at it with:
//
//   bun run start -- --gateway 127.0.0.1:6455
//
// It is a development convenience and deliberately small. It does not model the CL05 pixel
// protocol, power, or timing; only what arrives, and whether it would have been accepted.

import dgram from "node:dgram";
import { OP_POLL, createPollReply, opcodeOf, parseDmx } from "../artnet";
import { ARTNET_PORT, DMX_UNIVERSE_SIZE } from "../shared/patch";

export interface SimGateway {
  port: number;
  /** Latest data per universe. */
  universes: Map<number, Uint8Array>;
  accepted: number;
  /** Packets dropped for arriving from the wrong source port. */
  dropped: number;
  close(): void;
}

export function startSimGateway(opts: { port?: number; requireSourcePort?: number | null } = {}): Promise<SimGateway> {
  const requireSourcePort = opts.requireSourcePort === undefined ? ARTNET_PORT : opts.requireSourcePort;
  return new Promise((resolve, reject) => {
    const udp = dgram.createSocket({ type: "udp4", reuseAddr: false });
    const sim: SimGateway = { port: 0, universes: new Map(), accepted: 0, dropped: 0, close: () => udp.close() };

    udp.on("message", (buf, rinfo) => {
      const op = opcodeOf(buf);
      if (op === OP_POLL) {
        const reply = createPollReply({ ip: "127.0.0.1", shortName: "SIM-ArtNet", longName: "Simulated CL-104PS", universes: [0, 1, 2, 3] });
        udp.send(reply, rinfo.port, rinfo.address);
        return;
      }
      const dmx = parseDmx(buf);
      if (!dmx) return;
      if (requireSourcePort !== null && rinfo.port !== requireSourcePort) {
        sim.dropped += 1; // exactly what the real unit does, minus the blinking "No Signal"
        return;
      }
      sim.accepted += 1;
      let data = sim.universes.get(dmx.portAddress);
      if (!data) sim.universes.set(dmx.portAddress, (data = new Uint8Array(DMX_UNIVERSE_SIZE)));
      data.set(dmx.data);
    });
    udp.once("error", reject);
    udp.bind(opts.port ?? 6455, () => {
      sim.port = udp.address().port;
      resolve(sim);
    });
  });
}

/** Pixel n (0-based) of a chain of 3-channel GRB pixels starting at universe 0 channel 1, as RGB. */
export function simPixel(sim: SimGateway, n: number): [number, number, number] {
  const data = sim.universes.get(Math.floor(n / 170));
  if (!data) return [0, 0, 0];
  const o = (n % 170) * 3;
  return [data[o + 1]!, data[o]!, data[o + 2]!];
}

if (import.meta.main) {
  // --any-source-port relaxes the 6454 rule, for a second client running beside a real one.
  const anySource = process.argv.includes("--any-source-port");
  const quiet = process.argv.includes("--quiet");
  const tubes = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 21);
  const perTube = 32;
  const sim = await startSimGateway({ requireSourcePort: anySource ? null : ARTNET_PORT });
  console.log(`[sim] simulated gateway on udp/${sim.port} — showing ${tubes} tubes of ${perTube} GRB pixels`);
  console.log(`[sim] run the client with:  bun run start -- --gateway 127.0.0.1:${sim.port}\n`);

  let lastAccepted = 0;
  let lastDropped = 0;
  const reset = "\x1b[0m";
  if (!quiet) setInterval(() => {
    const lines: string[] = [];
    for (let t = 0; t < tubes; t++) {
      let line = `${String(t + 1).padStart(2)} `;
      for (let p = 0; p < perTube; p++) {
        const [r, g, b] = simPixel(sim, t * perTube + p);
        // Drive levels are linear light; brighten for the terminal so a dim pattern is visible.
        const d = (v: number) => Math.round(Math.pow(v / 255, 1 / 2.2) * 255);
        line += `\x1b[48;2;${d(r)};${d(g)};${d(b)}m  `;
      }
      lines.push(line + reset);
    }
    const rate = sim.accepted - lastAccepted;
    const droppedNow = sim.dropped - lastDropped;
    lastAccepted = sim.accepted;
    lastDropped = sim.dropped;
    const signal = rate > 0 ? `>>>> ${rate * 4} packets/s` : droppedNow > 0 ? `No Signal — dropping ${droppedNow * 4} packets/s from the wrong source port (need ${ARTNET_PORT})` : "No Signal";
    process.stdout.write(`\x1b[H\x1b[2J${lines.join("\n")}\n\n${signal}\n`);
  }, 250);
}
