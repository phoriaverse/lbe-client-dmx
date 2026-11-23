// `bun run probe` — find out by eye which wire address lights which physical pixel.
//
// A cursor (white) sits on one raw Art-Net address: a universe and the three channels starting at
// a channel. Move it with the arrow keys until it sits on the pixel you want, press Space, and a
// marker stays lit there. Markers alternate: GREEN for the first light of a tube, RED for its
// last, tube by tube along the chain. The result is a table of where every tube really starts and
// ends on the wire — the gateway's packing rule, measured rather than assumed.
//
// It makes no assumption about how pixels pack into universes, which is the point: it addresses
// channels directly (through a running lighting-client's /preview, like the editor does), so a
// gateway that packs differently from shared/patch.ts shows up as markers at unexpected addresses.
//
//   bun run probe                     # through the client on localhost:8091
//   bun run probe -- localhost:8093   # another client
//
//   ← →        one pixel (3 channels)          ↑ ↓      ten pixels
//   [ ]        one channel (if a marker's colour is wrong, the pixel is a channel off)
//   , .        previous / next universe, channel 1
//   Space      drop the next marker here       Backspace  remove the last marker
//   q          quit (the tubes go back to the client's idle look)
//
// Markers are saved to probe-markers.json after every change, and reloaded on the next run.

import fs from "node:fs";
import path from "node:path";
import { type Patch } from "../shared/patch";
import { DEFAULT_CONTROL_PORT, PREVIEW_PATH } from "../shared/preview-protocol";

const UNIVERSES = 4;
const PER_UNIVERSE = 510; // channels 1–510: what 170 three-channel "pixels" can reach
// Linear light, under the client's master and cap. The client re-encodes it for a gamma-1 run, so
// 0.04 reaches the wire at about 43/255 with the cap at 0.5: clear through the diffuser, not harsh.
const LEVEL = 0.04;
const FILE = path.resolve(import.meta.dir, "../../probe-markers.json");

interface Marker {
  tube: number;
  end: "first" | "last";
  universe: number;
  /** 1-based channel of the pixel's first channel. */
  channel: number;
}

const address = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? `localhost:${DEFAULT_CONTROL_PORT}`;
const gatewayHost = process.env.GATEWAY ?? "2.0.0.100";
const gatewayPort = process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : undefined;

// Raw channel access: every universe is one run of 170 "RGB" pixels at gamma 1, so frame sample
// (universe × 510 + n) IS channel n+1 of that universe, untouched by colour order or curve.
const patch: Patch = {
  pixelCount: UNIVERSES * 170,
  gateways: [{ id: "gw1", host: gatewayHost, ...(gatewayPort ? { port: gatewayPort } : {}) }],
  runs: Array.from({ length: UNIVERSES }, (_, u) => ({ first: u * 170, count: 170, gateway: "gw1", universe: u, channel: 1, order: "RGB" as const, gamma: 1 })),
};

let markers: Marker[] = [];
try {
  markers = JSON.parse(fs.readFileSync(FILE, "utf8")).markers ?? [];
} catch {
  /* no earlier run */
}
let universe = markers.at(-1)?.universe ?? 0;
let offset = (markers.at(-1)?.channel ?? 1) - 1; // 0-based channel of the cursor's first channel
const MAX_OFFSET = PER_UNIVERSE - 3;

const next = (): { tube: number; end: "first" | "last" } => {
  const last = markers.at(-1);
  if (!last) return { tube: 1, end: "first" };
  return last.end === "first" ? { tube: last.tube, end: "last" } : { tube: last.tube + 1, end: "first" };
};

function move(channels: number) {
  let abs = universe * PER_UNIVERSE + offset + channels;
  abs = Math.max(0, Math.min(UNIVERSES * PER_UNIVERSE - 3, abs));
  universe = Math.floor(abs / PER_UNIVERSE);
  offset = Math.min(abs % PER_UNIVERSE, MAX_OFFSET);
}

function frame(): Uint8Array {
  const out = new Uint8Array(UNIVERSES * PER_UNIVERSE);
  const v = Math.round(LEVEL * 255);
  // On a GRB pixel the first channel is green and the second red.
  for (const m of markers) out[m.universe * PER_UNIVERSE + (m.channel - 1) + (m.end === "first" ? 0 : 1)] = v;
  // The cursor on top, white — blinking off briefly so a marker underneath can still be seen.
  if (Date.now() % 1000 < 800) out.fill(v, universe * PER_UNIVERSE + offset, universe * PER_UNIVERSE + offset + 3);
  return out;
}

function save() {
  fs.writeFileSync(FILE, `${JSON.stringify({ note: "universe is 0-based as on the wire; channel is 1-based, the pixel's first channel", savedAt: new Date().toISOString(), markers }, null, 2)}\n`);
}

let owner = "?";
function draw() {
  const n = next();
  const lines = [
    `cursor   universe ${universe}  channels ${offset + 1}–${offset + 3}   (pixel ${Math.floor(offset / 3) + 1} of the universe${offset % 3 ? `, +${offset % 3} ch` : ""})`,
    `next     Space marks tube ${n.tube}'s ${n.end.toUpperCase()} light (${n.end === "first" ? "green" : "red"})`,
    `markers  ${markers.length}${markers.length ? ` — last: tube ${markers.at(-1)!.tube} ${markers.at(-1)!.end} at U${markers.at(-1)!.universe}.${markers.at(-1)!.channel}` : ""}`,
    `client   ${owner === "preview" ? "showing this probe" : `owner is "${owner}" — the probe is NOT on the tubes`}`,
    "",
    "← → pixel   ↑ ↓ ten pixels   [ ] one channel   , . universe   Space mark   Backspace undo   q quit",
  ];
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`);
}

const ws = new WebSocket(`ws://${address}${PREVIEW_PATH}`);
ws.onerror = () => {
  console.error(`no lighting-client at ${address} — start one (bun run start), then run the probe again`);
  process.exit(1);
};
ws.onmessage = (ev) => {
  try {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === "status") {
      owner = msg.problem ? `${msg.owner}: ${msg.problem}` : msg.owner;
      draw();
    }
  } catch {
    /* not for us */
  }
};

function quit() {
  try {
    ws.send(JSON.stringify({ type: "release" }));
  } catch {}
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  console.log(`\n${markers.length} markers saved to ${path.relative(process.cwd(), FILE)}`);
  setTimeout(() => process.exit(0), 150);
}

ws.onopen = () => {
  // transfer 1: the samples are linear drive levels, not the .show's 2.2-encoded light.
  ws.send(JSON.stringify({ type: "hello", app: "probe", bits: 8, transfer: 1, patch }));
  setInterval(() => ws.send(frame()), 50);
  draw();

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("end", quit);
  process.stdin.on("data", (data: Buffer) => {
    // Keys can arrive several to a chunk (key repeat), so walk the bytes.
    const s = data.toString("latin1");
    for (let i = 0; i < s.length; i++) {
      const rest = s.slice(i);
      if (rest.startsWith("\x1b[C")) (move(3), (i += 2));
      else if (rest.startsWith("\x1b[D")) (move(-3), (i += 2));
      else if (rest.startsWith("\x1b[A")) (move(30), (i += 2));
      else if (rest.startsWith("\x1b[B")) (move(-30), (i += 2));
      else if (s[i] === "]") move(1);
      else if (s[i] === "[") move(-1);
      else if (s[i] === ".") ((universe = Math.min(UNIVERSES - 1, universe + 1)), (offset = 0));
      else if (s[i] === ",") ((universe = Math.max(0, universe - 1)), (offset = 0));
      else if (s[i] === " ") {
        markers.push({ ...next(), universe, channel: offset + 1 });
        save();
      } else if (s[i] === "\x7f" || s[i] === "\b") {
        markers.pop();
        save();
      } else if (s[i] === "q" || s[i] === "\x03") return quit();
    }
    draw();
  });
};
