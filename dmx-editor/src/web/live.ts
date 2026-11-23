// The link to a running lighting-client.
//
// The page makes frames (preview.ts: Identify, or the sequence at the playhead) and, when asked,
// this puts them on the real fixtures through the client's /preview WebSocket. The editor never
// talks to a gateway itself: the client holds the only socket that can (source port 6454), and a
// live LBE session there always beats preview. `status.owner` says who is actually driving the wall.
//
// Protocol (dmx-client/src/shared/preview-protocol.ts): hello with the compiled patch, then
// binary frames. A stream that stops for PREVIEW_STALE_MS ends itself, so while anything is being
// previewed the caller re-sends the current frame every tick even when it hasn't changed.

import { type Patch, samePatch } from "../../../dmx-client/src/shared/patch";
import { PREVIEW_PATH, type PreviewHello, type PreviewPollResult, type PreviewReply, type PreviewStatus } from "../../../dmx-client/src/shared/preview-protocol";
import { SHOW_TRANSFER } from "../../../dmx-client/src/shared/show-file";
import { compileRigPatch, rigOrder } from "../model/patch";
import { encodeFrame } from "../model/pixels";
import type { RigDocument } from "../model/rig";

const WALK_STEP_MS = 2000;

export type LinkState = "off" | "connecting" | "connected" | "lost";

export interface LiveSnapshot {
  state: LinkState;
  url: string;
  status: PreviewStatus | null;
  poll: PreviewPollResult | null;
  polling: boolean;
  error: string | null;
  /** True while frames are going to the client. */
  streaming: boolean;
}

class LiveLink {
  private ws: WebSocket | null = null;
  private wanted = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private sentPatch: Patch | null = null;
  private patchFor: RigDocument | null = null;
  private patch: Patch | null = null;
  private listeners = new Set<() => void>();
  private snap: LiveSnapshot = { state: "off", url: "", status: null, poll: null, polling: false, error: null, streaming: false };

  get snapshot() {
    return this.snap;
  }

  private set(patch: Partial<LiveSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  // ── Connection ─────────────────────────────────────────────────────────────

  connect(address: string) {
    this.disconnect();
    this.wanted = true;
    const url = /^wss?:\/\//.test(address) ? address : `ws://${address.replace(/\/+$/, "")}${PREVIEW_PATH}`;
    this.set({ url, error: null });
    this.open(url);
  }

  disconnect() {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "release" }));
      } catch {}
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
    this.sentPatch = null;
    this.set({ state: "off", status: null, streaming: false });
  }

  private open(url: string) {
    this.set({ state: "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.set({ state: "lost", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.sentPatch = null;
      this.set({ state: "connected", error: null });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: PreviewReply;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "status") this.set({ status: msg });
      else if (msg.type === "pollResult") this.set({ poll: msg, polling: false });
    };
    ws.onclose = () => {
      this.ws = null;
      this.sentPatch = null;
      if (!this.wanted) return;
      this.set({ state: "lost", status: null, streaming: false, error: `no lighting-client at ${url}` });
      this.retry = setTimeout(() => this.wanted && this.open(url), 2000);
    };
  }

  private get open_() {
    return this.ws?.readyState === WebSocket.OPEN ? this.ws : null;
  }

  /** ArtPoll, through the client — it holds the only socket that may. */
  poll() {
    const ws = this.open_;
    if (!ws) return false;
    this.set({ polling: true });
    ws.send(JSON.stringify({ type: "poll" }));
    setTimeout(() => this.snap.polling && this.set({ polling: false }), 3000);
    return true;
  }

  // ── Frames ─────────────────────────────────────────────────────────────────

  private currentPatch(rig: RigDocument): Patch {
    if (this.patchFor !== rig) {
      this.patchFor = rig;
      this.patch = compileRigPatch(rig);
    }
    return this.patch!;
  }

  /** Put one frame (rig order, linear light) on the fixtures. False if there is no client to send to. */
  send(rig: RigDocument, frame: Float32Array): boolean {
    const ws = this.open_;
    if (!ws || frame.length === 0) {
      if (this.snap.streaming) this.set({ streaming: false });
      return false;
    }
    const patch = this.currentPatch(rig);
    if (!samePatch(patch, this.sentPatch)) {
      const hello: PreviewHello = { type: "hello", app: "lighting-editor", bits: 8, transfer: SHOW_TRANSFER, patch };
      ws.send(JSON.stringify(hello));
      this.sentPatch = patch;
    }
    ws.send(encodeFrame(frame, 8));
    if (!this.snap.streaming) this.set({ streaming: true });
    return true;
  }

  /** Give the wall back now rather than after the stale timeout. */
  release() {
    if (!this.snap.streaming) return;
    this.open_?.send(JSON.stringify({ type: "release" }));
    this.set({ streaming: false });
  }
}

export const live = new LiveLink();

/** Lights in rig (chain) order, for walking the chain one tube at a time. */
export function walkOrder(rig: RigDocument): string[] {
  return rigOrder(rig).map((s) => s.light.id);
}

export { WALK_STEP_MS };
