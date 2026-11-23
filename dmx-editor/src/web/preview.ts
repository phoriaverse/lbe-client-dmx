// The preview engine: what the rig looks like right now.
//
// Forty times a second it makes ONE frame and hands it to two consumers — the viewport, which
// colours its pixels, and (when asked) the lighting-client, which puts it on the real tubes:
//
//   Identify on     → the identify blink (pixels.ts). Always streamed to the client.
//   otherwise       → the open sequence at the playhead, from THE evaluator (model/evaluate.ts),
//                     fed with pictures grabbed from <video> elements. Streamed only while
//                     "Live" is on.
//
// The bake runs the same evaluator with pictures from ffmpeg instead. The only differences
// between preview and bake are therefore the decoder and its scaler, never the lighting maths.
//
// It also owns the playhead. While playing, the first video is the clock (its sound and picture
// are what the eye and ear follow, and it stalls honestly when it buffers); other videos are
// nudged to it. Past the end of every video, a plain timer carries the playhead to the end.

import { buildPlan, evaluateFrame, type Picture, type SamplePlan } from "../model/evaluate";
import { darkFrame, identifyFrame } from "../model/pixels";
import { isLight, type RigDocument, subtree } from "../model/rig";
import { sampleDims, type SequenceDocument, sequenceDurationMs, videosInUse } from "../model/sequence";
import { live } from "./live";

const TICK_MS = 25; // 40 Hz — the client's output rate, and far inside its 1s stale timeout
const BLINK_ON_MS = 400;
const BLINK_PERIOD_MS = 600;
/** On-screen exposure for identify: its 0.12 linear should read clearly, not as grey. */
const IDENTIFY_EXPOSURE = 6;
const RESYNC_MS = 120;

interface Slot {
  name: string;
  el: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  error: string | null;
}

export interface VideoState {
  ready: boolean;
  /** Undefined until the metadata has loaded. */
  durationMs: number | undefined;
  width: number;
  height: number;
  error: string | null;
}

export interface PreviewSnapshot {
  timeMs: number;
  playing: boolean;
  /** The sequence's length: its override, or its longest video. 0 while unknown. */
  durationMs: number;
  videos: Record<string, VideoState>;
}

export type FrameListener = (frame: Float32Array | null, exposure: number) => void;

class Preview {
  private rig: RigDocument | null = null;
  private seq: SequenceDocument | null = null;
  private plan: SamplePlan | null = null;
  private planFor: [RigDocument | null, SequenceDocument | null] = [null, null];
  private slots = new Map<string, Slot>();
  private urls = new Map<string, string>();
  private holder: HTMLDivElement | null = null;
  private frame: Float32Array | null = null;
  /** The pictures need re-grabbing: a seek landed, a video loaded, or the documents changed. */
  private stale = true;
  private timeMs = 0;
  private playing = false;
  private clock = { at: 0, timeMs: 0 };
  private identifyTargets: Set<string> | null = null;
  private liveOutput = false;
  private sound = false;
  private frameListeners = new Set<FrameListener>();
  private listeners = new Set<() => void>();
  private snap: PreviewSnapshot = { timeMs: 0, playing: false, durationMs: 0, videos: {} };
  private lastEmit = 0;

  constructor() {
    if (typeof window !== "undefined") setInterval(() => this.tick(), TICK_MS);
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  get snapshot() {
    return this.snap;
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  onFrame(fn: FrameListener) {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  private emit(force = false) {
    const now = performance.now();
    if (!force && now - this.lastEmit < 66) return; // the playhead readout does not need 40 Hz
    this.lastEmit = now;
    const videos: Record<string, VideoState> = {};
    for (const [name, s] of this.slots) {
      videos[name] = {
        ready: s.el.readyState >= 2,
        durationMs: Number.isFinite(s.el.duration) ? s.el.duration * 1000 : undefined,
        width: s.el.videoWidth,
        height: s.el.videoHeight,
        error: s.error,
      };
    }
    this.snap = { timeMs: this.timeMs, playing: this.playing, durationMs: this.durationMs(), videos };
    for (const fn of this.listeners) fn();
  }

  // ── Documents and media ────────────────────────────────────────────────────

  /** Video name → URL, from /api/media. */
  setMedia(videos: { name: string; url: string }[]) {
    this.urls = new Map(videos.map((v) => [v.name, v.url]));
    this.reconcile();
  }

  /** Called on every rig or sequence change. */
  setDocs(rig: RigDocument, seq: SequenceDocument) {
    const switched = this.seq?.id !== seq.id;
    this.rig = rig;
    this.seq = seq;
    if (switched) {
      this.pause();
      this.timeMs = 0;
    }
    this.reconcile();
    if (switched) this.seek(0);
    this.stale = true;
  }

  setLiveOutput(on: boolean) {
    this.liveOutput = on;
  }

  setSound(on: boolean) {
    this.sound = on;
    this.applySound();
  }

  /** Nodes to identify (a group identifies every light under it), or null to stop. */
  identify(rig: RigDocument, nodeIds: readonly string[] | null) {
    this.rig = rig;
    this.identifyTargets = nodeIds ? new Set(nodeIds.flatMap((id) => subtree(rig, id).filter(isLight).map((n) => n.id))) : null;
    this.stale = true;
  }

  /** The <video> a surface is showing, for the viewport to draw. */
  videoFor(surfaceId: string): HTMLVideoElement | null {
    const name = this.seq?.surfaces[surfaceId]?.video;
    return (name && this.slots.get(name)?.el) || null;
  }

  private durationMs(): number {
    if (!this.rig || !this.seq) return 0;
    return sequenceDurationMs(this.rig, this.seq, (v) => {
      const d = this.slots.get(v)?.el.duration;
      return d !== undefined && Number.isFinite(d) ? d * 1000 : undefined;
    });
  }

  /** One <video> per video in use; none for videos no longer used. */
  private reconcile() {
    if (!this.rig || !this.seq) return;
    const wanted = new Set(videosInUse(this.rig, this.seq));
    for (const [name, slot] of this.slots) {
      if (wanted.has(name) && this.urls.get(name) === slot.el.dataset.url) continue;
      slot.el.pause();
      slot.el.removeAttribute("src");
      slot.el.load();
      slot.el.remove();
      this.slots.delete(name);
    }
    for (const name of wanted) {
      if (this.slots.has(name)) continue;
      const url = this.urls.get(name);
      if (!url) continue; // not on disk (or the list has not arrived): the sequence panel says so
      this.slots.set(name, this.makeSlot(name, url));
    }
    this.applySound();
    this.emit(true);
  }

  private makeSlot(name: string, url: string): Slot {
    if (!this.holder) {
      // In the document but out of sight: browsers stop decoding a video that is not attached at all.
      this.holder = document.createElement("div");
      this.holder.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none";
      document.body.appendChild(this.holder);
    }
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.dataset.url = url;
    el.src = url;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const slot: Slot = { name, el, canvas, ctx, error: null };
    const fresh = () => {
      this.stale = true;
      this.emit(true);
    };
    el.addEventListener("loadedmetadata", () => {
      el.currentTime = Math.min(this.timeMs / 1000, el.duration || 0);
      fresh();
    });
    el.addEventListener("loadeddata", fresh);
    el.addEventListener("seeked", fresh);
    el.addEventListener("error", () => {
      slot.error = el.error?.message || "the browser could not play this video";
      fresh();
    });
    this.holder.appendChild(el);
    return slot;
  }

  private applySound() {
    let first = true;
    for (const slot of this.slots.values()) {
      slot.el.muted = !(this.sound && first);
      first = false;
    }
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  play() {
    if (this.playing) return;
    const duration = this.durationMs();
    if (duration > 0 && this.timeMs >= duration - 1) this.seek(0);
    this.playing = true;
    this.clock = { at: performance.now(), timeMs: this.timeMs };
    for (const slot of this.slots.values()) this.startSlot(slot);
    this.emit(true);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const slot of this.slots.values()) slot.el.pause();
    this.stale = true;
    this.emit(true);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(timeMs: number) {
    const duration = this.durationMs();
    this.timeMs = Math.max(0, duration > 0 ? Math.min(timeMs, duration) : timeMs);
    this.clock = { at: performance.now(), timeMs: this.timeMs };
    for (const slot of this.slots.values()) {
      const end = slot.el.duration;
      if (!Number.isFinite(end)) continue;
      slot.el.currentTime = Math.min(this.timeMs / 1000, end);
      if (this.playing) this.startSlot(slot);
    }
    this.stale = true;
    this.emit(true);
  }

  private startSlot(slot: Slot) {
    const end = slot.el.duration;
    if (!Number.isFinite(end) || this.timeMs / 1000 >= end) return;
    // A refused play() (no user gesture yet) leaves the timer clock running; the picture catches up on the next click.
    slot.el.play().catch(() => {});
  }

  // ── The tick ───────────────────────────────────────────────────────────────

  private currentPlan(): SamplePlan | null {
    if (!this.rig || !this.seq) return null;
    if (this.planFor[0] !== this.rig || this.planFor[1] !== this.seq) {
      this.planFor = [this.rig, this.seq];
      this.plan = buildPlan(this.rig, this.seq);
    }
    return this.plan;
  }

  private advance() {
    const now = performance.now();
    const master = [...this.slots.values()].find((s) => s.el.readyState >= 2 && !s.el.paused && !s.el.ended);
    if (master) {
      this.timeMs = master.el.currentTime * 1000;
      this.clock = { at: now, timeMs: this.timeMs };
      for (const slot of this.slots.values()) {
        if (slot === master || slot.el.paused || slot.el.ended) continue;
        if (Math.abs(slot.el.currentTime * 1000 - this.timeMs) > RESYNC_MS) slot.el.currentTime = this.timeMs / 1000;
      }
    } else {
      this.timeMs = this.clock.timeMs + (now - this.clock.at);
    }
    const duration = this.durationMs();
    if (duration > 0 && this.timeMs >= duration) {
      this.timeMs = duration;
      this.pause();
    }
  }

  /** The picture a video is showing at the playhead, or null: not loaded, or the playhead is past its end. */
  private grab(slot: Slot): Picture | null {
    const { el, canvas, ctx } = slot;
    if (el.readyState < 2 || !el.videoWidth) return null;
    if (el.ended || this.timeMs / 1000 >= el.duration) return null;
    const { width, height } = sampleDims(el.videoWidth, el.videoHeight, this.seq!.sampleSize);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
      ctx.drawImage(el, 0, 0, width, height);
      return { width, height, stride: 4, data: ctx.getImageData(0, 0, width, height).data };
    } catch {
      return null;
    }
  }

  private tick() {
    const rig = this.rig;
    const seq = this.seq;
    if (!rig || !seq) return;
    if (this.playing) this.advance();

    let frame: Float32Array | null;
    let exposure = 1;
    let changed = false;
    if (this.identifyTargets) {
      frame = identifyFrame(rig, this.identifyTargets, performance.now() % BLINK_PERIOD_MS < BLINK_ON_MS);
      exposure = IDENTIFY_EXPOSURE;
      changed = true;
      this.stale = true; // repaint the sequence when identify stops
    } else {
      const plan = this.currentPlan()!;
      if (this.playing || this.stale || !this.frame || this.frame.length !== plan.pixelCount * 3) {
        this.stale = false;
        changed = true;
        if (plan.surfaces.length) {
          const pictures = new Map<string, Picture | null>();
          for (const slot of this.slots.values()) pictures.set(slot.name, this.grab(slot));
          this.frame = evaluateFrame(plan, (v) => pictures.get(v) ?? null, this.frame?.length === plan.pixelCount * 3 ? this.frame : undefined);
        } else this.frame = darkFrame(plan.pixelCount);
      }
      frame = this.frame;
      // Show the picture at full range whatever the baked level is; the level is for the wall.
      exposure = seq.level > 0 ? 1 / seq.level : 1;
    }

    if (changed) for (const fn of this.frameListeners) fn(frame, exposure);
    if ((this.identifyTargets || this.liveOutput) && frame) live.send(rig, frame);
    else live.release();
    if (this.playing) this.emit();
  }
}

export const preview = new Preview();
