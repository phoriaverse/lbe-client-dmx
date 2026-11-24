// Shared wire behavior for the independently deployed room players.
import type { ClientMessage, JourneyVisit } from "./protocol";

type Play = (startAt: number, complete: () => void) => void;
export class JourneyPlayer {
  private visit?: JourneyVisit;
  private controller?: AbortController;
  private play?: Play;
  private prepared = false;
  private ready = false;
  private started = false;

  constructor(
    private send: (message: ClientMessage) => void,
    private synced: () => boolean,
    private prepare: (visit: JourneyVisit, signal: AbortSignal) => Promise<Play | void>,
  ) {}

  exit() {
    this.controller?.abort();
    this.visit = undefined;
    this.play = undefined;
    this.prepared = this.ready = this.started = false;
  }

  async enter(visit: JourneyVisit) {
    if (this.visit?.visitId === visit.visitId) {
      this.report();
      return;
    }
    this.exit();
    this.visit = visit;
    const controller = new AbortController();
    this.controller = controller;
    console.info("[journey]", visit.state, visit.visitId);
    try {
      const play = await this.prepare(visit, controller.signal);
      if (controller.signal.aborted) return;
      this.play = play || undefined;
      this.ready = !play;
      this.prepared = true;
      this.report();
    } catch (error) {
      if (!controller.signal.aborted) console.error("[journey] preparation failed", visit.state, error);
    }
  }
  report() {
    if (this.visit && this.prepared && this.synced())
      this.send({ type: "journeyVote", visitId: this.visit.visitId, prepared: true, ready: this.ready });
  }
  start(visitId: string, startAt: number) {
    if (this.visit?.visitId !== visitId || this.started) return;
    this.started = true;
    const controller = this.controller;
    this.play?.(startAt, () => {
      if (controller?.signal.aborted) return;
      this.ready = true;
      this.report();
    });
  }
}
