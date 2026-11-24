import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtNetSocket } from "../src/artnet";
import { ServerClock } from "../src/clock";
import type { Config } from "../src/config";
import { Engine } from "../src/engine";
import { Output } from "../src/output";
import type { Session } from "../src/session";
import { type Patch, simplePatch } from "../src/shared/patch";
import { AMBIENT_EXPERIENCE, SHOW_TRANSFER, SHOW_VERSION, type ShowHeader, encodeShowHeader } from "../src/shared/show-file";
import { ShowLibrary } from "../src/shows";
import { type SimGateway, simPixel, startSimGateway } from "../src/tools/sim-gateway";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// gamma 1 with transfer 2.2 makes the wire value equal the sample, so a frame can carry its own
// index in pixel 0's red channel and the test can read back WHICH frame is on the wire.
const FPS = 40;

function writeShow(dir: string, file: string, experience: string, patch: Patch, frames: number, tag: (frame: number) => number, loop = false) {
  const header: ShowHeader = {
    version: SHOW_VERSION, name: file, experience, fps: FPS, bits: 8, pixelCount: patch.pixelCount, frameCount: frames,
    transfer: SHOW_TRANSFER, patch, bakedAt: new Date().toISOString(),
  };
  if (loop) header.loop = true;
  const head = encodeShowHeader(header);
  const out = new Uint8Array(head.length + frames * patch.pixelCount * 3);
  out.set(head);
  for (let f = 0; f < frames; f++) out[head.length + f * patch.pixelCount * 3] = tag(f);
  fs.writeFileSync(path.join(dir, file), out);
}

class FakeSession {
  states: string[] = [];
  readies = 0;
  setState(s: string) { this.states.push(s); }
  sendReady() { this.readies += 1; }
  get last() { return this.states[this.states.length - 1]; }
}

describe("engine", () => {
  let dir: string;
  let sim: SimGateway;
  let socket: ArtNetSocket;
  let engine: Engine;
  let session: FakeSession;
  let clock: ServerClock;
  let patch: Patch;

  const boot = async (opts: { ambient?: boolean } = {}) => {
    sim = await startSimGateway({ port: 0, requireSourcePort: null });
    socket = await ArtNetSocket.open(0);
    patch = simplePatch({ host: "127.0.0.1", port: sim.port, fixtures: 2, pixelsPerFixture: 4, gamma: 1 });
    writeShow(dir, "test.show", "Test X", patch, 20, (f) => f + 1); // 0.5s, frames tagged 1…20
    if (opts.ambient) writeShow(dir, "ambient.show", AMBIENT_EXPERIENCE, patch, 4, () => 200, true);

    const config: Config = {
      output: "artnet", usbUniverse: 0, standalone: false, localPath: path.join(dir, "config.local.json"),
      name: "test", server: undefined, controlPort: 0, showsDir: dir, outputFps: 200, outputLatencyMs: 0,
      master: 1, cap: 1, sequenced: false, sourcePort: 0, patch, pixelsPerFixture: 4,
    };
    const output = new Output(socket);
    output.setPatch(patch);
    clock = new ServerClock();
    session = new FakeSession();
    engine = new Engine(config, output, clock, new ShowLibrary(dir));
    engine.attach(session as unknown as Session);
    engine.start();
    await wait(40);
  };

  const red = () => simPixel(sim, 0)[0];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lighting-engine-"));
  });
  afterEach(async () => {
    await engine.stop();
    socket.close();
    sim.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a full session: ready → dark until startAt → frames by the clock → dark → idle", async () => {
    await boot();
    expect(engine.owner).toBe("idle");
    expect(red()).toBe(0);

    engine.onStartExperience("Test X");
    expect(session.states).toEqual(["Test X - Preparing", "Test X - Ready"]);
    expect(session.readies).toBe(1);

    const startAt = clock.now() + 150;
    engine.onBeginPlayback(startAt);
    await wait(60);
    expect(red()).toBe(0); // armed, not yet started
    expect(engine.positionMs()).toBeUndefined();

    await wait(150 + 200 - 60); // now ~200ms into the show
    const position = clock.now() - startAt;
    const expected = Math.floor((position * FPS) / 1000) + 1;
    expect(Math.abs(red() - expected)).toBeLessThanOrEqual(1); // the frame the CLOCK says, give or take one
    expect(session.last).toBe("Test X - Playing");
    expect(engine.owner).toBe("session");
    expect(engine.positionMs()).toBeGreaterThan(150);

    await wait(400); // past the 0.5s show
    expect(red()).toBe(0); // dark after the last frame, still in session
    expect(engine.owner).toBe("session");

    engine.onCloseExperience("media");
    expect(session.last).toBe("idle");
    await wait(30);
    expect(engine.owner).toBe("idle");
  });

  test("matches the experience name forgivingly, and reports ready even with no show", async () => {
    await boot();
    engine.onStartExperience("test-x");
    expect(session.last).toBe("test-x - Ready");
    engine.onCloseExperience("operator");

    engine.onStartExperience("Unknown Experience");
    expect(session.last).toBe("Unknown Experience - Ready (no lighting show)");
    expect(session.readies).toBe(2); // fail the light, not the room
    engine.onBeginPlayback(clock.now());
    await wait(40);
    expect(session.last).toBe("Unknown Experience - Playing");
    expect(red()).toBe(0);
  });

  test("a close or a begin with no session is ignored", async () => {
    await boot();
    engine.onCloseExperience("media");
    engine.onBeginPlayback(clock.now());
    await wait(30);
    expect(session.states).toEqual([]);
    expect(engine.owner).toBe("idle");
  });

  test("the ambient loop plays when idle, holds until startAt, and returns after the close", async () => {
    await boot({ ambient: true });
    expect(engine.owner).toBe("ambient");
    expect(red()).toBe(200);

    engine.onStartExperience("Test X");
    await wait(30);
    expect(red()).toBe(200); // at the Ready barrier the room keeps its idle look

    engine.onBeginPlayback(clock.now() + 50);
    await wait(150);
    expect(red()).toBeGreaterThan(0);
    expect(red()).toBeLessThan(21); // now it is the show

    engine.onCloseExperience("media");
    await wait(30);
    expect(red()).toBe(200);
    expect(engine.owner).toBe("ambient");
  });

  test("a session beats a test pattern and a live preview; blackout beats everything", async () => {
    await boot();
    expect(engine.setPattern("red", 1)).toBeNull();
    await wait(30);
    expect(engine.owner).toBe("pattern");
    expect(red()).toBe(255);

    engine.previewHello({ type: "hello", app: "test", bits: 8, transfer: 2.2, patch });
    engine.previewFrame(new Uint8Array(patch.pixelCount * 3).fill(77));
    await wait(30);
    expect(engine.owner).toBe("pattern"); // pattern outranks preview

    engine.setPattern(null);
    await wait(30);
    expect(engine.owner).toBe("preview");
    expect(red()).toBe(77);

    engine.onStartExperience("Test X");
    engine.onBeginPlayback(clock.now());
    await wait(60);
    expect(engine.owner).toBe("session");
    expect(red()).toBeLessThan(21);
    expect(engine.setPattern("red")).toContain("session is running");

    engine.setBlackout(true);
    await wait(30);
    expect(engine.owner).toBe("blackout");
    expect(red()).toBe(0);
    engine.setBlackout(false);
    engine.onCloseExperience("operator");
  });

  test("a preview that stops sending is dropped; a wrong-sized frame is refused", async () => {
    await boot();
    engine.previewHello({ type: "hello", app: "test", bits: 8, transfer: 2.2, patch });
    engine.previewFrame(new Uint8Array(5));
    expect(engine.status.preview.problem).toContain("5 bytes");
    await wait(30);
    expect(engine.owner).toBe("idle");

    engine.previewFrame(new Uint8Array(patch.pixelCount * 3).fill(90));
    await wait(30);
    expect(engine.owner).toBe("preview");
    expect(engine.status.preview.problem).toBeNull();
    engine.previewRelease();
    await wait(30);
    expect(engine.owner).toBe("idle");
    expect(red()).toBe(0);
  });

  test("16-bit preview frames arrive intact", async () => {
    await boot();
    engine.previewHello({ type: "hello", app: "test", bits: 16, transfer: 2.2, patch });
    const frame = new Uint16Array(patch.pixelCount * 3).fill(0x8080);
    engine.previewFrame(new Uint8Array(frame.buffer));
    await wait(30);
    expect(red()).toBe(128); // 0x8080/65535 ≈ 0.502 → 128
  });
});
