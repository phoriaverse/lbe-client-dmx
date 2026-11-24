// lighting-client — the LBE's lighting player.
//
// Plays baked .show files through Art-Net or ENTTEC USB on the same clock as the headsets.
// The editor previews through this client; it does not open its own hardware connection.
//
//   bun run start                              # discover the control server, drive the configured rig
//   bun run start -- --server 192.168.1.50:8080
//   bun run start -- --gateway 127.0.0.1:6455  # point the default rig at `bun run sim`
//
// Flags: --server host:port · --name "Roster name" · --port <control port> · --shows <dir>
//        --gateway host[:port] · --source-port <udp port>
//        --config <file> · --output artnet|enttec|preview · --usb-device <path> · --standalone

import { ArtNetSocket } from "./artnet";
import { ServerClock } from "./clock";
import { loadConfig } from "./config";
import { startControlServer } from "./control";
import { Discovery } from "./discovery";
import { Engine } from "./engine";
import { Output } from "./output";
import { Session } from "./session";
import { ARTNET_PORT } from "./shared/patch";
import { ShowLibrary } from "./shows";
import { EnttecUsb } from "./enttec";
import { PreviewTransport, type DmxTransport } from "./transport";

const config = loadConfig();

let socket: DmxTransport;
try {
  socket = config.output === "enttec"
    ? await EnttecUsb.open(config.usbDevice, config.usbUniverse, config.outputFps)
    : config.output === "preview"
      ? new PreviewTransport(config.previewUsbUniverse)
      : await ArtNetSocket.open(config.sourcePort);
} catch (err) {
  console.error(`[lighting] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
if (socket.kind === "artnet" && socket.sourcePort !== ARTNET_PORT) {
  console.warn(`[lighting] sending from UDP ${socket.sourcePort}, not ${ARTNET_PORT} — a real CL-104PS will ignore this. Fine for the simulator.`);
}

const output = new Output(socket, config.sequenced);
// Take the rig from the first tick. The gateway holds its last frame forever, so if a previous run
// crashed with the lights on, this is what turns them off: the idle look is sent from the start.
output.setPatch(config.patch);

const clock = new ServerClock();
const library = new ShowLibrary(config.showsDir);
const engine = new Engine(config, output, clock, library);
const session = new Session(new Discovery(config.server), clock, config.name, {
  onStartExperience: (experience) => engine.onStartExperience(experience),
  onBeginPlayback: (startAt) => engine.onBeginPlayback(startAt),
  onCloseExperience: (reason) => engine.onCloseExperience(reason),
  positionMs: () => engine.positionMs(),
});
engine.attach(session);

engine.start();
if (!config.standalone) session.start();
const server = startControlServer({ config, engine, output, socket, session, library });

console.log(`[lighting] "${config.name}" — ${output.description}`);
console.log(`[lighting] output: ${socket.label}`);
console.log(`[lighting] master ${Math.round(config.master * 100)}% · cap ${Math.round(config.cap * 100)}% · ${config.outputFps}fps · shows in ${config.showsDir}`);
console.log(`[lighting] control page: http://localhost:${server.port}`);

// Leaving the lights on is the failure mode of this hardware — it holds whatever it last heard.
// So every way out of this process goes through a repeated blackout first.
let exiting = false;
async function shutdown(code: number) {
  if (exiting) return;
  exiting = true;
  try { await engine.stop(); }
  catch (err) { console.error(`[lighting] blackout failed: ${err}`); code = 1; }
  try { await socket.close(); }
  catch (err) { console.error(`[lighting] output close failed: ${err}`); code = 1; }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGHUP", () => void shutdown(0));
process.on("uncaughtException", (err) => {
  console.error(`[lighting] fatal: ${err.stack ?? err}`);
  void shutdown(1);
});
process.on("unhandledRejection", (err) => {
  console.error(`[lighting] unhandled rejection: ${err instanceof Error ? err.stack : err}`);
  void shutdown(1);
});
