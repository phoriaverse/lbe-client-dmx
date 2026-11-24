# dmx-client

## Audience journey

Each server visit is logged under its own state name. The rig looks up that state's local show, primes it and renders against the shared start instant. It votes ready at the end of the timeline. An unassigned cue logs and votes ready immediately. Seating, Onboarding and Doffing can each receive a distinct lighting sequence as designs become available. SoundSpace discovery defaults to UDP 41235 and service `soundspace`. [Journey and operator controls](../../../server/web/JOURNEY.md)

The single-experience session described below is supported in legacy rehearsal mode.

The LBE's lighting player. It plays baked `.show` files to Art-Net pixel fixtures, starting on the
same clock-synced instant as the headsets and screens.

It is **playback only**, and it is the **only program that ever sends Art-Net**. Authoring — the 3D
scene, the timeline, the bake — is `dmx-editor/`, which previews on the real fixtures *through*
a running client rather than beside it.

## Run it

```bash
cd dmx-client
bun install
bun run start
```

Then open **http://localhost:8091** — the control page.

The Mac needs an address on the gateway's network. For the CL-104PS on `2.0.0.100` that is a
temporary alias on whichever interface the cable is in (`ifconfig` shows it; it was `en9` on
2026-11-13), and it is lost on unplug or restart:

```bash
sudo ifconfig en9 alias 2.0.0.2 255.0.0.0
```

| Flag | Meaning |
| --- | --- |
| `--server host:port` | Pin the control server instead of discovering it |
| `--name "Lighting"` | Name in the console's roster (default: this Mac's hostname) |
| `--port 8091` | Control page / editor preview port |
| `--shows <dir>` | Where the `.show` files are (default `shows/`) |
| `--gateway host[:port]` | Repoint the default rig — at the simulator, usually |
| `--source-port <n>` | UDP source port. Leave at 6454 for real hardware |

## What it does, in order of who wins

Forty times a second exactly one thing owns the fixtures:

1. **Blackout** — the stop button on the control page. Beats everything, including a running show.
2. **Session** — an LBE experience in progress.
3. **Test pattern** — from the control page.
4. **Editor preview** — frames streamed live from `lighting-editor`.
5. **Ambient** — the idle loop, if a show named `ambient` exists.
6. **Dark.**

A session beating patterns and preview is the rule that a live show always wins: nobody's bench
work is on the wall when the room starts.

## In a session

It joins the control server as role `player`, like a screen, so it needs no server change:

1. `startExperience "Second Nature"` → it finds the `.show` whose header names that experience,
   maps it, and reports `ready`.
2. `beginPlayback { startAt }` → at that server-clock instant it starts reading frames.
   The frame is `floor((serverNow − startAt + outputLatencyMs) × fps)`, recomputed every tick —
   nothing accumulates, so there is nothing to drift over a long show.
3. `closeExperience` → back to the idle look, reports `idle`.

Three behaviours worth knowing:

- **A missing show does not hold the room.** It reports `ready` anyway and keeps the idle look —
  the roster shows `… - Ready (no lighting show)`. Fail the light, not the room.
- **A dropped connection does not stop the lights.** Playback runs on the last good clock and the
  reconnect picks up the close. If the close never comes, it returns to idle by itself 15s after
  the show's last frame.
- **It never sends `durationMs` on `ready`.** That field is a screen reporting its video's length
  for the server to check; a lighting show's length is not that.

Experience names are matched exactly first, then by slug (`Second Nature` = `second-nature`). The
name is the "magic string" the editor's sequence nominates — it has to match what the console
sends, i.e. the keys in `bun-server/src/experiences.ts`.

## Brightness

`config.json` holds the site defaults; the control page's master slider writes to
`config.local.json` (gitignored) so moving it never dirties a tracked file.

- **`cap`** — the site ceiling. What 100% means here. Default **0.5**, deliberately: the
  full-brightness test of a 21-tube chain is still an open item in the hardware notes.
- **`master`** — the operator dimmer underneath it.

Both scale **light**, not fader position: 0.5 is half the light and about half the power. They
multiply, and neither needs a re-bake.

## Hardware facts this is built around

From the bench (Notion: *CL05 Tubes*, *CL-104PS*):

- **The source UDP port must be 6454.** The CL-104PS silently drops ArtDmx from any other source
  port while still answering ArtPoll. So the client *binds* 6454 — which is also why only one
  program can drive the fixtures: a second one fails at startup, loudly, instead of flickering.
- **The gateway holds its last frame forever.** So every universe is re-sent every tick, a universe
  that leaves the patch is zeroed ten times, and every way out of the process (Ctrl-C, SIGTERM, a
  crash) goes through a repeated blackout. Starting the client is also the recovery: it sends the
  idle look from its first tick.
- **170 pixels per universe**, never straddling: `universe = ⌊n/170⌋`, `channel = 3·(n mod 170)+1`.
  21 tubes × 32 pixels is 672 pixels across universes 0–3.
- **GRB**, and **linear** response — hence `gamma: 2.2` on the fixture, applied at output.

## Files

```
config.json            site defaults: rig, cap, fps, latency
config.local.json      on-site overrides written by the control page (gitignored)
shows/*.show           baked shows (gitignored) — the only thing a show Mac needs from the editor
src/
  index.ts             entry: wires everything, blackout on every exit
  engine.ts            the tick: who owns the fixtures, which frame, by the server clock
  output.ts            frame → drive levels → universes (gamma, master, cap, colour order)
  artnet.ts            packets and the one socket bound to 6454
  session.ts           the LBE WebSocket (role "player")
  clock.ts             NTP-lite sync against the server clock
  discovery.ts         finds the control server by UDP beacon
  shows.ts             the show library: which file answers to which experience
  patterns.ts          test patterns
  control.ts           control page API + the editor's /preview WebSocket
  shared/              patch model, .show format, preview protocol — imported by lighting-editor too
  tools/               poll, sim-gateway, make-test-show
```

`src/shared/` is the contract with the editor. There is one definition of the patch and one of the
file format; the editor imports them from here.

## The .show file

One baked sequence, self-contained: `"LBESHOW1"`, a JSON header (experience name, fps, bit depth,
pixel count, **the patch**), then raw frames — R G B per pixel, in frame order.

Samples are linear light encoded with a 2.2 power curve, which is what makes 8 bits enough: the
codes are spent where fades live. **fps and bit depth are per-file settings** (default 40 fps,
8-bit); a 16-bit bake is the answer if dim fades step visibly. Details in
`src/shared/show-file.ts`.

## Tools

```bash
bun run poll                      # who is on the fixture network? (lights nothing)
bun run make-test-show            # bake a synthetic show for "Test A" — no editor needed
bun run make-test-show -- --experience "Second Nature" --seconds 195.767
bun run make-test-show -- --ambient
bun run sim                       # a simulated CL-104PS in the terminal, on udp/6455
bun run start -- --gateway 127.0.0.1:6455     # …and a client pointed at it
bun test
```

The synthetic show flashes the whole rig for 100ms on every whole second and fills a bar along the
chain over its length — readable by eye against a clock.

`bun run poll` binds 6454 too, so it will not run beside a client; the control page shows the same
thing (the gateway pill in the header).

## Not done

- **On-site latency calibration.** `outputLatencyMs` is 0. The delay from packet to photon through
  the CL-104PS has not been measured.
- **Deployment.** No LaunchAgent yet; `video-client/scripts/install-screen.sh` is the model.
- **A permanent address on the fixture network.** The `ifconfig` alias above is lost on restart.
