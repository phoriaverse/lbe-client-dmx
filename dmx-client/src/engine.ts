// The engine: decides, forty times a second, what the fixtures should be showing — and sends it.
//
// There are several things that might want the fixtures, and exactly one wins each tick, in this
// order:
//
//   1. blackout   the operator's stop button. Beats everything, including a running show.
//   2. session    an LBE experience in progress. The reason this program exists.
//   3. pattern    a test pattern from the control page.
//   4. preview    frames streamed live from lighting-editor.
//   5. ambient    the idle loop, if a show named "ambient" has been baked.
//   6. idle       dark.
//
// A session beating pattern and preview is the "a live show always wins" rule: nobody's bench work
// or half-open editor can be on the wall when the room starts.
//
// PLAYBACK HAS NO STATE TO DRIFT. The frame index is recomputed from the server clock on every
// tick — floor((serverNow − startAt + latency) × fps). Nothing is accumulated, so a late tick, a
// dropped tick or an eight-minute show all land on the same frame a perfect player would.

import type { ServerClock } from "./clock";
import type { Config } from "./config";
import type { Output } from "./output";
import { type Pattern, type PatternContext, patternById } from "./patterns";
import type { CloseReason } from "./protocol";
import type { Session } from "./session";
import { type Patch, compilePatch, validatePatch } from "./shared/patch";
import { type OutputOwner, PREVIEW_STALE_MS, type PreviewHello } from "./shared/preview-protocol";
import { durationMsOf, frameView } from "./shared/show-file";
import type { LoadedShow, ShowLibrary } from "./shows";

type Frame = Uint8Array | Uint16Array;
type Phase = "preparing" | "ready" | "playing";

// A session whose close never arrives (the server died, the LAN dropped) would otherwise sit on a
// finished show forever. Once the show has been over this long, go back to idle unprompted.
const SELF_CLOSE_GRACE_MS = 15_000;
const IDLE_RESCAN_MS = 3000;

interface ActiveSession {
  experience: string;
  phase: Phase;
  show: LoadedShow | null;
  /** Server-clock instant of the synchronized start, once beginPlayback has arrived. */
  startAt: number | null;
}

interface PreviewStream {
  patch: Patch;
  bits: 8 | 16;
  transfer: number;
  frame: Frame;
  /** performance.now() of the last frame; 0 until the first arrives. */
  at: number;
}

interface ActivePattern {
  pattern: Pattern;
  level: number;
  startedAt: number;
  frame: Uint8Array;
  ctx: PatternContext;
  patch: Patch;
}

export class Engine {
  private session: Session | null = null;
  private active: ActiveSession | null = null;
  private ambient: LoadedShow | null = null;
  private readonly ambientEpoch = performance.now();
  private pattern: ActivePattern | null = null;
  private preview: PreviewStream | null = null;
  private previewProblem: string | null = null;
  private blackout = false;
  private master: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastScanAt = 0;
  private signature = "";

  owner: OutputOwner = "idle";
  /** Called when anything an observer would care about changes (owner, session, levels). */
  onChange: () => void = () => {};

  // Scheduling health: how late ticks fire, over the last second.
  private lateSum = 0;
  private lateMax = 0;
  private lateCount = 0;
  private lateWindowStart = performance.now();
  timing = { meanLateMs: 0, maxLateMs: 0, fps: 0 };

  constructor(
    private readonly config: Config,
    private readonly output: Output,
    private readonly clock: ServerClock,
    private readonly library: ShowLibrary,
  ) {
    this.master = config.master;
    this.output.setLevels({ master: this.master, cap: config.cap });
    this.rescan();
  }

  attach(session: Session) {
    this.session = session;
  }

  // ── LBE session ────────────────────────────────────────────────────────────

  onStartExperience(experience: string, signal?: AbortSignal) {
    this.rescan(true);
    this.pattern = null; // a live show always wins
    this.active = { experience, phase: "preparing", show: null, startAt: null };
    this.session?.setState(`${experience} - Preparing`);

    const entry = this.library.find(experience);
    let note = "";
    if (!entry) {
      // Fail the light, not the room: holding eight headsets at the Ready barrier because a
      // lighting machine is missing a bake is the worse failure. Report ready and stay on idle.
      console.warn(`[engine] no show answers to "${experience}" — reporting ready anyway and holding the idle look`);
      note = " (no lighting show)";
    } else {
      try {
        const show = this.library.load(entry);
        void show.bytes[show.show.dataOffset]; // touch the first frame so it is paged in before the start
        this.active.show = show;
        const h = show.show.header;
        console.log(`[engine] "${experience}" → ${entry.file} (${h.frameCount} frames @ ${h.fps}fps ${h.bits}-bit, ${(durationMsOf(h) / 1000).toFixed(1)}s)`);
      } catch (err) {
        console.error(`[engine] could not load ${entry.file}: ${err instanceof Error ? err.message : err} — holding the idle look`);
        note = " (lighting show unreadable)";
      }
    }

    this.active.phase = "ready";
    this.session?.setState(`${experience} - Ready${note}`);
    if (!signal) this.session?.sendReady();
    this.changed();
    return this.active.show ? durationMsOf(this.active.show.show.header) : undefined;
  }

  onBeginPlayback(startAt: number) {
    if (!this.active) return; // a start we never saw (we joined mid-session) — nothing to begin
    this.active.startAt = startAt;
    console.log(`[engine] synchronized start in ${Math.max(0, startAt - this.clock.now()).toFixed(0)}ms (server clock ${startAt.toFixed(0)})`);
  }

  onCloseExperience(reason: CloseReason | "self") {
    if (!this.active) return; // idle in the lobby: the close was for a session we are not in
    console.log(`[engine] closeExperience (${reason}) — "${this.active.experience}" over`);
    this.active = null;
    this.session?.setState("idle");
    this.changed();
  }

  /** Playback position in ms from the shared start; undefined when not playing. */
  positionMs(): number | undefined {
    const a = this.active;
    if (!a || a.phase !== "playing" || a.startAt === null) return undefined;
    return Math.max(0, this.clock.now() - a.startAt);
  }

  // ── Operator controls ──────────────────────────────────────────────────────

  setBlackout(on: boolean) {
    this.blackout = on;
    console.log(`[engine] blackout ${on ? "ON" : "off"}`);
    this.changed();
  }

  setMaster(value: number) {
    this.master = Math.min(1, Math.max(0, value));
    this.output.setLevels({ master: this.master, cap: this.config.cap });
    this.changed();
  }

  /** Start a test pattern, or stop it with null. Returns a reason if it could not start. */
  setPattern(id: string | null, level = 0.3): string | null {
    if (id === null) {
      this.pattern = null;
      this.changed();
      return null;
    }
    const pattern = patternById(id);
    if (!pattern) return `no pattern called "${id}"`;
    const patch = this.config.patch ?? this.output.patch;
    if (!patch) return "no patch to run a pattern on — set a rig in config.json";
    if (this.active) return "an LBE session is running — test patterns wait for it to finish";

    // Same pattern, new level (the page's slider): adjust in place so a chase does not restart.
    if (this.pattern?.pattern === pattern && this.pattern.patch === patch) {
      this.pattern.level = this.pattern.ctx.level = Math.min(1, Math.max(0, level));
      this.changed(true);
      return null;
    }

    const compiled = compilePatch(patch);
    const universeStarts: number[] = [];
    for (let p = 1; p < patch.pixelCount; p++) {
      if (compiled.slotOf[p]! >= 0 && compiled.slotOf[p - 1]! >= 0 && compiled.slotOf[p] !== compiled.slotOf[p - 1]) universeStarts.push(p);
    }
    this.pattern = {
      pattern,
      level: Math.min(1, Math.max(0, level)),
      startedAt: performance.now(),
      frame: new Uint8Array(patch.pixelCount * 3),
      ctx: { pixelCount: patch.pixelCount, pixelsPerFixture: this.config.pixelsPerFixture, universeStarts, level: Math.min(1, Math.max(0, level)) },
      patch,
    };
    this.changed();
    return null;
  }

  // ── Editor preview ─────────────────────────────────────────────────────────

  previewHello(hello: PreviewHello): string | null {
    const problems = hello.patch ? validatePatch(hello.patch) : ["no patch"];
    if (hello.bits !== 8 && hello.bits !== 16) problems.push(`bits ${hello.bits}`);
    if (problems.length) {
      this.preview = null;
      this.previewProblem = `preview rejected: ${problems[0]}`;
    } else {
      const samples = hello.patch.pixelCount * 3;
      this.preview = {
        patch: hello.patch,
        bits: hello.bits,
        transfer: hello.transfer > 0 ? hello.transfer : 2.2,
        frame: hello.bits === 16 ? new Uint16Array(samples) : new Uint8Array(samples),
        at: 0,
      };
      this.previewProblem = null;
    }
    this.changed();
    return this.previewProblem;
  }

  previewFrame(bytes: Uint8Array) {
    const p = this.preview;
    if (!p) return;
    const expected = p.frame.length * (p.bits / 8);
    if (bytes.length !== expected) {
      this.setPreviewProblem(`preview frame is ${bytes.length} bytes; the patch needs ${expected}`);
      return;
    }
    if (p.frame instanceof Uint16Array) {
      // Copy bytewise: the incoming buffer has no alignment guarantee, so it cannot be viewed as
      // 16-bit in place.
      new Uint8Array(p.frame.buffer).set(bytes);
    } else {
      p.frame.set(bytes);
    }
    p.at = performance.now();
    this.setPreviewProblem(null);
  }

  previewRelease() {
    if (this.preview) this.preview.at = 0;
  }

  private setPreviewProblem(problem: string | null) {
    if (problem === this.previewProblem) return;
    this.previewProblem = problem;
    if (problem) console.warn(`[preview] ${problem}`);
    this.changed();
  }

  // ── The tick ───────────────────────────────────────────────────────────────

  start() {
    const period = 1000 / this.config.outputFps;
    let due = performance.now();
    const loop = () => {
      const now = performance.now();
      this.recordLateness(now - due);
      try {
        this.tick(now);
      } catch (err) {
        // One bad frame must not stop the loop: a stopped loop leaves the last frame on the wall.
        console.error(`[engine] tick failed: ${err instanceof Error ? err.stack : err}`);
      }
      due += period;
      // After a long stall (sleep, debugger) do not fire a burst to catch up — just resume.
      if (due < performance.now() - period * 4) due = performance.now();
      this.timer = setTimeout(loop, Math.max(0, due - performance.now()));
    };
    loop();
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.output.blackout();
  }

  private tick(now: number) {
    if (!this.active && now - this.lastScanAt > IDLE_RESCAN_MS) this.rescan();

    let owner: OutputOwner;
    let frame: Frame | null = null;
    let transfer = 2.2;
    let patch: Patch | null = null;

    const sessionFrame = this.active ? this.sessionFrame(this.active) : null;
    const pattern = this.pattern;
    const preview = this.preview;

    if (this.blackout) {
      owner = "blackout";
      patch = this.output.patch ?? this.config.patch;
    } else if (sessionFrame) {
      owner = "session";
      ({ frame, transfer, patch } = sessionFrame);
    } else if (!this.active && pattern) {
      owner = "pattern";
      pattern.frame.fill(0);
      pattern.pattern.render(pattern.frame, now - pattern.startedAt, pattern.ctx);
      frame = pattern.frame;
      patch = pattern.patch;
    } else if (!this.active && preview && preview.at > 0 && now - preview.at < PREVIEW_STALE_MS) {
      owner = "preview";
      frame = preview.frame;
      transfer = preview.transfer;
      patch = preview.patch;
    } else if (this.ambient) {
      // Before the synchronized start (and for an experience with no show) the room keeps its idle
      // look rather than going dark — the hand-over to the show is a cut at startAt.
      owner = this.active ? "session" : "ambient";
      const { show, bytes } = this.ambient;
      const index = Math.floor(((now - this.ambientEpoch) * show.header.fps) / 1000) % show.header.frameCount;
      frame = frameView(bytes, show, index);
      transfer = show.header.transfer;
      patch = show.header.patch;
    } else {
      owner = this.active ? "session" : "idle";
      patch = this.config.patch ?? this.output.patch;
    }

    this.output.setPatch(patch);
    this.output.render(frame, transfer);

    if (owner !== this.owner) {
      this.owner = owner;
      this.changed();
    }
  }

  /** The show frame for right now, or null if the session has nothing of its own to put up yet. */
  private sessionFrame(a: ActiveSession): { frame: Frame | null; transfer: number; patch: Patch } | null {
    if (a.startAt === null) return null;
    // Read the show `outputLatencyMs` AHEAD: a light that takes time to respond needs the future.
    const position = this.clock.now() - a.startAt + this.config.outputLatencyMs;
    if (position < 0) return null;

    if (a.phase !== "playing") {
      a.phase = "playing";
      this.session?.setState(`${a.experience} - Playing`);
    }
    if (!a.show) return null;

    const { show, bytes } = a.show;
    const h = show.header;
    let index = Math.floor((position * h.fps) / 1000);
    if (h.loop) index %= h.frameCount;

    if (index >= h.frameCount) {
      if (position > durationMsOf(h) + SELF_CLOSE_GRACE_MS) {
        console.warn("[engine] the show ended and no close arrived — returning to idle on our own");
        this.onCloseExperience("self");
        return null;
      }
      return { frame: null, transfer: h.transfer, patch: h.patch }; // past the end: dark, on the show's patch
    }
    return { frame: frameView(bytes, show, index), transfer: h.transfer, patch: h.patch };
  }

  private rescan(force = false) {
    this.lastScanAt = performance.now();
    if (!this.library.scan() && !force) return;
    const entry = this.library.ambient();
    try {
      // Keep the mapping we have if the file is unchanged — re-mapping every start would be waste.
      if (!entry) this.ambient = null;
      else if (this.ambient?.path !== entry.path || this.ambient.mtimeMs !== entry.mtimeMs) this.ambient = this.library.load(entry);
    } catch (err) {
      console.error(`[engine] could not load the ambient show: ${err instanceof Error ? err.message : err}`);
      this.ambient = null;
    }
    this.changed();
  }

  private recordLateness(lateMs: number) {
    const late = Math.max(0, lateMs);
    this.lateSum += late;
    this.lateMax = Math.max(this.lateMax, late);
    this.lateCount += 1;
    const now = performance.now();
    const span = now - this.lateWindowStart;
    if (span >= 1000) {
      this.timing = { meanLateMs: this.lateSum / this.lateCount, maxLateMs: this.lateMax, fps: (this.lateCount * 1000) / span };
      this.lateSum = 0;
      this.lateMax = 0;
      this.lateCount = 0;
      this.lateWindowStart = now;
    }
  }

  private changed(force = false) {
    const signature = JSON.stringify([this.owner, this.active?.experience, this.active?.phase, this.previewProblem, this.master, this.blackout, this.pattern?.pattern.id]);
    if (signature === this.signature && !force) return;
    this.signature = signature;
    this.onChange();
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  get status() {
    const a = this.active;
    const h = a?.show?.show.header;
    return {
      owner: this.owner,
      blackout: this.blackout,
      master: this.master,
      cap: this.config.cap,
      session: a
        ? {
            experience: a.experience,
            phase: a.phase,
            show: a.show?.file ?? null,
            positionMs: this.positionMs() ?? null,
            durationMs: h ? durationMsOf(h) : null,
          }
        : null,
      pattern: this.pattern ? { id: this.pattern.pattern.id, level: this.pattern.level } : null,
      preview: {
        connected: this.preview !== null,
        streaming: !!this.preview && this.preview.at > 0 && performance.now() - this.preview.at < PREVIEW_STALE_MS,
        problem: this.previewProblem,
      },
      ambient: this.ambient?.file ?? null,
      timing: this.timing,
    };
  }
}
