// The control port: a small page for whoever is standing at the lighting machine, and the
// WebSocket lighting-editor streams live preview frames to.
//
// Nothing here is on the timing path. The engine ticks on its own clock whether or not anyone has
// this page open; these are just the knobs (master, blackout, test patterns) and the window
// (what is playing, is the gateway there, what is on the wire right now).
//
// Bound to every interface, like the control server's console, so the editor on another Mac can
// preview through a client on the show Mac. There is no auth — same trust model as the rest of the
// LBE: whoever is on the show LAN is in the room.

import path from "node:path";
import type { ServerWebSocket } from "bun";
import type { DmxTransport } from "./transport";
import { type Config, saveLocal } from "./config";
import type { Engine } from "./engine";
import type { Output } from "./output";
import { PATTERNS } from "./patterns";
import type { Session } from "./session";
import { ARTNET_PORT } from "./shared/patch";
import { PREVIEW_PATH, type PreviewMessage, type PreviewReply, type PreviewStatus } from "./shared/preview-protocol";
import { durationMsOf } from "./shared/show-file";
import type { ShowLibrary } from "./shows";

const webDir = path.join(process.env.LBE_LIGHTING_RESOURCES ?? import.meta.dir, "web");

interface Deps {
  config: Config;
  engine: Engine;
  output: Output;
  socket: DmxTransport;
  session: Session;
  library: ShowLibrary;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function startControlServer({ config, engine, output, socket, session, library }: Deps) {
  const previewSockets = new Set<ServerWebSocket<unknown>>();

  const gatewayTargets = () => (output.patch?.gateways ?? config.patch?.gateways ?? []).map((g) => ({ host: g.host, port: g.port ?? ARTNET_PORT }));

  const previewStatus = (): PreviewStatus => {
    const s = engine.status;
    return {
      type: "status",
      owner: s.owner,
      session: s.session ? { experience: s.session.experience, phase: s.session.phase } : null,
      problem: s.preview.problem,
      master: s.master,
      cap: s.cap,
      output: { kind: socket.kind, label: socket.label, connected: socket.connected, error: socket.error },
    };
  };

  const reply = (ws: ServerWebSocket<unknown>, msg: PreviewReply) => ws.send(JSON.stringify(msg));
  engine.onChange = () => {
    const status = previewStatus();
    for (const ws of previewSockets) reply(ws, status);
  };

  const status = () => {
    const nodes = socket.knownNodes();
    const patch = output.patch;
    return {
      name: config.name,
      engine: engine.status,
      lbe: { ...session.status, enabled: !config.standalone },
      output: {
        kind: socket.kind,
        label: socket.label,
        connected: socket.connected,
        error: socket.error,
        description: output.description,
        fps: config.outputFps,
        latencyMs: config.outputLatencyMs,
        sourcePort: socket.sourcePort,
        packetsSent: socket.packetsSent,
        sendFailures: socket.failures,
        pixelCount: patch?.pixelCount ?? 0,
        pixelsPerFixture: config.pixelsPerFixture,
        fixtureGammas: [...new Set(patch?.runs.map((run) => run.gamma) ?? [])],
        gateways: (socket.kind === "artnet" ? patch?.gateways ?? [] : []).map((g) => {
          const node = nodes.find((n) => n.from === g.host);
          return {
            id: g.id,
            host: g.host,
            port: g.port ?? ARTNET_PORT,
            // "seen" means it answered an ArtPoll recently. It does NOT mean it is accepting our
            // data — the CL-104PS answers polls while dropping every frame (wrong source port).
            seen: node ? Date.now() - node.seenAt < 15_000 : false,
            name: node?.shortName ?? null,
            universes: node?.universes ?? null,
          };
        }),
      },
      shows: library.shows.map((s) => ({
        file: s.file,
        state: s.state,
        experience: s.show.header.experience,
        name: s.show.header.name,
        durationMs: durationMsOf(s.show.header),
        fps: s.show.header.fps,
        bits: s.show.header.bits,
        pixelCount: s.show.header.pixelCount,
        bakedAt: s.show.header.bakedAt,
        sizeBytes: s.size,
      })),
      showProblems: library.problems,
      patterns: PATTERNS.map(({ id, label, asks }) => ({ id, label, asks })),
    };
  };

  // Keep "is the gateway there?" current without anyone having to press Scan.
  const pollGateways = () => void socket.poll(gatewayTargets(), 400).catch(() => {});
  if (socket.kind === "artnet") {
    pollGateways();
    setInterval(pollGateways, 5000);
  }
  // USB disconnects are independent of engine ownership changes; keep the editor informed.
  setInterval(() => { for (const ws of previewSockets) reply(ws, previewStatus()); }, 1000);

  const server = Bun.serve({
    port: config.controlPort,
    hostname: "0.0.0.0",

    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === PREVIEW_PATH) {
        return server.upgrade(req) ? undefined : new Response("expected a WebSocket", { status: 426 });
      }

      if (req.method === "GET") {
        if (url.pathname === "/") return new Response(Bun.file(path.join(webDir, "index.html")), { headers: { "cache-control": "no-store" } });
        if (url.pathname === "/icon.png") return new Response(Bun.file(path.join(webDir, "icon.png")));
        if (url.pathname === "/api/status") return json(status());
        // What is on the wire right now: drive levels, R G B per pixel, frame order.
        if (url.pathname === "/api/frame") {
          return new Response(output.lastDriveLevels.slice(), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
        }
        if (url.pathname === "/api/appearance") {
          return new Response(output.lastDisplayLevels.slice(), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
        }
      }

      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        switch (url.pathname) {
          case "/api/master": {
            const value = Number(body.value);
            if (!Number.isFinite(value)) return json({ error: "value must be a number 0–1" }, 400);
            engine.setMaster(value);
            saveLocal({ master: engine.status.master }, config.localPath);
            return json({ master: engine.status.master });
          }
          case "/api/blackout":
            engine.setBlackout(body.on === true);
            return json({ blackout: engine.status.blackout });
          case "/api/pattern": {
            const id = typeof body.id === "string" ? body.id : null;
            const problem = engine.setPattern(id, typeof body.level === "number" ? body.level : undefined);
            return problem ? json({ error: problem }, 409) : json({ pattern: engine.status.pattern });
          }
          case "/api/poll": {
            const nodes = await socket.poll(gatewayTargets(), 800);
            return json({ nodes });
          }
        }
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      // A 16-bit frame for a few thousand pixels is tens of kilobytes; leave generous headroom.
      maxPayloadLength: 8 * 1024 * 1024,
      open(ws) {
        previewSockets.add(ws);
        reply(ws, previewStatus());
      },
      async message(ws, raw) {
        if (typeof raw !== "string") {
          engine.previewFrame(raw);
          return;
        }
        let msg: PreviewMessage;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.type === "hello") {
          engine.previewHello(msg);
          reply(ws, previewStatus());
        } else if (msg.type === "release") {
          engine.previewRelease();
        } else if (msg.type === "poll") {
          const nodes = await socket.poll(gatewayTargets(), 800);
          reply(ws, { type: "pollResult", nodes: nodes.map(({ ip, shortName, longName, ports, universes }) => ({ ip, shortName, longName, ports, universes })) });
        }
      },
      close(ws) {
        previewSockets.delete(ws);
        // The editor went away: stop previewing now rather than a stale-timeout later.
        if (previewSockets.size === 0) engine.previewRelease();
      },
    },
  });

  return server;
}
