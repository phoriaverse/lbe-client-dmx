// The server clock, as seen from here.
//
// Every LBE client lands on the same instant by sharing ONE clock — the control server's monotonic
// clock — rather than by being told "go" over a network with variable delay. This is the NTP-lite
// handshake the headsets and screens run: send our own time t0, the server echoes it with its clock
// tServer, and on arrival (our time t3) the offset is tServer − (t0 + t3)/2, assuming the two legs
// took equally long. The sample with the LOWEST round trip is the one least likely to have been
// held up asymmetrically, so that is the one kept.
//
// The clock is measured on the round trip the output sits at the end of: this process holds both
// the WebSocket and the UDP socket the fixtures hang off, so nothing else is between the
// measurement and the light.

import type { ClientDiagnostics } from "./protocol";

const WINDOW = 8;

export class ServerClock {
  private offset = 0; // serverClock ≈ performance.now() + offset
  private samples: { offset: number; rtt: number }[] = [];
  private bestRtt = 0;
  private jitter = 0;
  private lastSampleAt = 0;
  synced = false;

  /** The server's clock right now, in ms. Meaningless until `synced`. */
  now(): number {
    return performance.now() + this.offset;
  }

  /** Convert a server-clock instant to this process's performance.now() timeline. */
  toLocal(serverMs: number): number {
    return serverMs - this.offset;
  }

  /** Fold in a timeSyncReply. `t0` is what we sent; call this the moment the reply arrives. */
  record(t0: number, tServer: number) {
    const t3 = performance.now();
    const rtt = t3 - t0;
    if (rtt < 0) return;

    this.samples.push({ offset: tServer - (t0 + t3) / 2, rtt });
    if (this.samples.length > WINDOW) this.samples.shift();

    const best = this.samples.reduce((b, s) => (s.rtt < b.rtt ? s : b));
    this.offset = best.offset;
    this.bestRtt = best.rtt;
    const mean = this.samples.reduce((a, s) => a + s.offset, 0) / this.samples.length;
    this.jitter = Math.sqrt(this.samples.reduce((a, s) => a + (s.offset - mean) ** 2, 0) / this.samples.length);
    this.lastSampleAt = t3;
    this.synced = true;
  }

  /** A new connection may be a new server with a new clock zero — old samples would poison it. */
  reset() {
    this.samples = [];
    this.synced = false;
  }

  /** What the console's clock-diagnostics roster shows for us. `positionMs` only while playing. */
  diagnostics(positionMs?: number): ClientDiagnostics {
    const diag: ClientDiagnostics = {
      clockSynced: this.synced,
      offsetMs: this.offset,
      rttMs: this.bestRtt,
      jitterMs: this.jitter,
      sampleAgeMs: this.synced ? performance.now() - this.lastSampleAt : 0,
      serverNowEstimateMs: this.now(),
    };
    if (positionMs !== undefined) diag.positionMs = positionMs;
    return diag;
  }
}
