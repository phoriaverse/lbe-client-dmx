import { JourneyPlayer } from "./journey-player";
// The LBE side: one WebSocket to the control server, as a full session participant.
//
// We identify as role "player" — the role a screen has — because a lighting rig wants the identical
// lifecycle: told to start an experience, held at the Ready barrier with everyone else, released by
// the same beginPlayback instant, torn down by the same closeExperience. That is why this needs no
// server change.
//
// This file is transport only. What to DO about a start, a begin or a close is the engine's
// business (engine.ts); this just keeps the socket up, keeps the clock synced, and reports.

import type { ServerClock } from "./clock";
import type { Discovery, ServerAddress } from "./discovery";
import { CLIENT_TYPE, type CloseReason, type CloseSupersededCode, type OutboundMessage, type ServerMessage } from "./protocol";

const CLOSE_SUPERSEDED: CloseSupersededCode = 4000;
const RETRY_MS = 1000;
const CONNECT_TIMEOUT_MS = 5000;
const DIAGNOSTICS_MS = 1000;
// Probe quickly at first so the clock is good before the first session, then settle.
const FAST_PROBES = 5;
const FAST_PROBE_MS = 250;
const SLOW_PROBE_MS = 2000;

export interface SessionHandlers {
  onStartExperience(experience: string, signal?: AbortSignal): number | undefined;
  onBeginPlayback(startAt: number): void;
  onCloseExperience(reason: CloseReason): void;
  /** Where playback is, in ms from the shared start, or undefined when not playing. */
  positionMs(): number | undefined;
}

export class Session {
  private ws: WebSocket | null = null;
  private server: ServerAddress | null = null;
  private state = "idle";
  private probes = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
  private superseded = false;
  connected = false;

  constructor(
    private readonly discovery: Discovery,
    private readonly clock: ServerClock,
    private readonly name: string,
    private readonly handlers: SessionHandlers,
  ) {}

  private journey = new JourneyPlayer(m => this.send(m), () => this.clock.synced, async (visit, signal) => {
    this.setState(visit.state);
    signal.addEventListener("abort", () => this.handlers.onCloseExperience("operator"), {once:true});
    const duration = await this.handlers.onStartExperience(visit.state, signal);
    if (!duration || signal.aborted) return;
    return (startAt, complete) => {
      this.handlers.onBeginPlayback(startAt);
      const timer = setTimeout(complete, Math.max(0, startAt + duration - this.clock.now()));
      signal.addEventListener("abort", () => clearTimeout(timer), {once:true});
    };
  });

  start() {
    this.discovery.start();
    setInterval(() => this.tryConnect(), RETRY_MS);
    this.tryConnect();
  }

  get status() {
    return {
      connected: this.connected,
      server: this.server ? `${this.server.host}:${this.server.port}` : null,
      superseded: this.superseded,
      state: this.state,
    };
  }

  /** Report our state to the console's roster. Remembered, so a reconnect re-reports it. */
  setState(state: string) {
    if (state === this.state) return;
    this.state = state;
    console.log(`[session] state -> ${state}`);
    this.send({ type: "state", state });
  }

  /**
   * Reached the Ready barrier. Deliberately WITHOUT durationMs: that field is a screen reporting
   * its video's true length for the server to check against experiences.ts, and a lighting show's
   * length is not that — sending it would raise a false "duration disagrees" warning.
   */
  sendReady() {
    this.send({ type: "ready" });
  }

  private send(msg: OutboundMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private tryConnect() {
    if (this.ws || this.superseded) return;
    const server = this.discovery.current();
    if (!server) return;

    const url = `ws://${server.host}:${server.port}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.server = server;

    // An unreachable host can leave a WebSocket "connecting" for a minute; give up and retry.
    const timeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      this.connected = true;
      console.log(`[session] connected to ${url} as "${this.name}"`);
      // A new connection may be a restarted server, whose clock has a new zero.
      this.clock.reset();
      this.send({ type: "identify", role: "player", name: this.name, clientType: CLIENT_TYPE });
      this.send({ type: "state", state: this.state });
      this.probes = 0;
      this.probe();
      this.diagnosticsTimer = setInterval(() => {
        this.send({ type: "diagnostics", diag: this.clock.diagnostics(this.handlers.positionMs()) });
      }, DIAGNOSTICS_MS);
    });

    ws.addEventListener("message", (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (msg.type) {
        case "journeyVisit": void this.journey.enter(msg); break;
        case "journeyExit": this.journey.exit(); break;
        case "journeyStart": this.journey.start(msg.visitId, msg.startAt); break;
        case "timeSyncReply":
          const first = !this.clock.synced;
          this.clock.record(msg.t0, msg.tServer);
          if (first) this.journey.report();
          break;
        case "startExperience":
          this.handlers.onStartExperience(msg.experience);
          break;
        case "beginPlayback":
          this.handlers.onBeginPlayback(msg.startAt);
          break;
        case "closeExperience":
          this.handlers.onCloseExperience(msg.reason);
          break;
        case "command":
          // Generic operator broadcast. Nothing to act on, but ack so the console's count is right.
          this.send({ type: "ack", commandId: msg.commandId });
          break;
      }
    });

    ws.addEventListener("close", (ev) => {
      clearTimeout(timeout);
      if (this.probeTimer) clearTimeout(this.probeTimer);
      if (this.diagnosticsTimer) clearInterval(this.diagnosticsTimer);
      this.probeTimer = null;
      this.diagnosticsTimer = null;
      if (this.ws === ws) this.ws = null;

      if (this.connected) console.warn(`[session] disconnected from ${url}${ev.reason ? ` (${ev.reason})` : ""}`);
      this.connected = false;

      // We lost a duplicate-connection race: a newer lighting-client of this name is in the room.
      // Reconnecting would evict it, it would evict us, and the two would flap forever.
      if (ev.code === CLOSE_SUPERSEDED) {
        this.journey.exit();
        this.superseded = true;
        console.error("[session] superseded by another lighting-client with this name — not reconnecting");
      }
      // Note what is NOT here: nothing stops playback. A dropped socket mid-show keeps the lights
      // running on the last good clock, and the reconnect picks up the close.
    });

    ws.addEventListener("error", () => {
      // "close" follows and does the bookkeeping; an unreachable server is routine, not an error.
    });
  }

  private probe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: "timeSync", t0: performance.now() });
    this.probes += 1;
    this.probeTimer = setTimeout(() => this.probe(), this.probes < FAST_PROBES ? FAST_PROBE_MS : SLOW_PROBE_MS);
  }
}
