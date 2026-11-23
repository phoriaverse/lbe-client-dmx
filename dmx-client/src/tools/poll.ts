// `bun run poll [host]` — find Art-Net nodes. Sends nothing that lights a fixture.
//
// Binds UDP 6454 like the client does, so it will refuse to run while a client is up; ask the
// running client instead (its control page has a Scan button).

import { ArtNetSocket } from "../artnet";
import { ARTNET_PORT } from "../shared/patch";

const host = process.argv[2];
const socket = await ArtNetSocket.open();
const nodes = await socket.poll(host ? [{ host, port: ARTNET_PORT }] : [], 1000);
socket.close();

if (nodes.length === 0) {
  console.log("No Art-Net nodes answered. Check the cable, and that this Mac has an address on the gateway's network.");
  process.exit(1);
}
for (const n of nodes) {
  console.log(`${n.from.padEnd(15)} "${n.shortName}" — ${n.longName} — ${n.ports} port(s), universes ${n.universes.join(", ")}` + (n.ip !== n.from ? ` (reports itself as ${n.ip})` : ""));
}
