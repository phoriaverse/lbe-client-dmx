# dmx-editor

Deploy a bake by copying it to the DMX client’s media directory under the journey state name, for example `seating.show`. [Playback and journey behavior](../dmx-client/README.md)


The LBE's lighting authoring tool. **Milestone 2: the rig editor.** You place the fixtures in a 3D
model of the room, wire them into chains, and press Identify to check each tube on the wall.
**Milestone 3: video surfaces and the bake.** You place video surfaces among the lights, a sequence
plays a video on them, the lights sample it, and a bake writes the `.show` that `lighting-client`
plays in a session.

Live output goes through a running **`dmx-client/`** (its `/preview`
WebSocket), which is the only program that drives the fixtures. A live LBE session there always wins.

For the eight **PavoTube II 30XR** tubes with ENTTEC USB and TimoLink TX, use
`bun run start:pavotube` and follow [PAVOTUBE_SETUP.md](../PAVOTUBE_SETUP.md).
The normal `start` command below loads the original CL05 rig. Network Scan applies only to Art-Net.

## Run it

```bash
cd dmx-editor
bun install
bun run start          # → http://localhost:8092
```

For Identify and Scan you also need a lighting client running. Check first, because a second client
can't bind UDP 6454:

```bash
lsof -ti tcp:8091 || (cd ../dmx-client && bun run start)
```

The editor connects to `localhost:8091` by default. Change it in the **Live** tab, for example to
preview through the client on the show Mac.

| Flag | Meaning |
| --- | --- |
| `--port 8092` | Editor port |
| `--host 127.0.0.1` | Bind address. Use `0.0.0.0` to open the editor from another Mac |
| `--rig <file>` | The rig file (default `project/rig.json`). Sequences live in `sequences/` beside it |
| `--shows <dir>` | Where bakes are written (default `../dmx-client/shows`) |

## Using it

The editor frames the loaded rig automatically. **Frame all** returns to the overview;
**Frame selected** or **F** focuses the selection (F frames everything if nothing is selected).
Double-click a tube in the left hierarchy to jump to it. **Q** hides the transform handles and
lets you pan. Thin fixture guides keep unlit tubes visible across a large room and show sampled
pixel colours during preview. These guides affect only the viewport, not the output or patch.

1. **Room** tab → **Import…** a GLB. If the readout ("6.00 × 3.00 × 8.00 m") isn't the room's real
   size, fix the scale (m / cm / mm / in / ft) and the rotation (**Z-up → Y-up** for most CAD exports).
2. **Place lights in wire order**: the first tube off the gateway goes first. **+ Tube** places a
   single tube. **+ Rail** places 3 or 5 tubes under a group. New lights go on the end of the active
   chain, so placement order *is* chain order.
3. Move them with the **Unity Scene View controls** (below), or type into the Inspector. Drag
   nodes onto a group in the hierarchy to parent them; they keep their world position.
4. **Identify** (**I**) blinks the selected tube dim white with **pixel 0 red**. That red pixel is the
   data-in end, marked by the red cone in the viewport, so a tube drawn backwards shows up straight
   away. Identify follows the selection, so with several selected they all blink. **Walk the chain**
   steps through every tube in wire order.
5. **⌘S** saves. There is no autosave yet (milestone 6). The page warns you if you close it with
   unsaved changes.

If the header says **CLIENT: BLACKOUT**, the physical lights are held dark even during Identify
or Live preview. Release blackout on the [client controls](http://localhost:8091) when ready to
drive the real tubes. A rig with no video surfaces/media has nothing to play yet: use Identify to
inspect fixtures, or follow the video workflow below to create lighting content.

## Video surfaces, sequences and the bake

1. **+ Surface** (above the hierarchy) adds a video surface. It is a rig node like a light: move it
   with the same gizmo, parent it under a group, and it is saved in the rig file.
2. In the **Sequence** tab, pick a video for each surface. Videos are read from
   `dmx-editor/media/` and then the repo-root `media/`, so a show video is never copied.
3. **Play** (or **Space**) and scrub along the bottom of the viewport. The tubes in the viewport
   show what they would do. Switch **Live** on to send the same frames to the real tubes through
   the lighting-client. Live is off after every page load.
   Fixture colours now include sequence level, the connected client's master/cap, profile gains
   and 8-bit DMX quantisation. The **Preview ×…%** label shows master × cap (100% when offline).
   Identify is no longer boosted and sequence level is no longer normalised away. The scene
   remains an estimated colour preview, with visible unlit guides; it does not simulate room
   bounce/glare or mirror test patterns selected on the client's page.
4. Set **Experience** and choose **Bake .show**. For the Second Nature state, copy the result
   to `dmx-client/media/second nature.show`. The client picks it up on the next visit.
   `bun run bake -- <sequence-id>` does the same from a terminal. The bake needs ffmpeg
   (`brew install ffmpeg`).

| Projection | What a light samples |
| --- | --- |
| **Planar** | The point straight in front of or behind it on a rectangle (along the surface's local Z). Depth doesn't matter. Seen from +Z the picture reads the right way round |
| **Dome** | A fisheye picture by direction from the surface's origin: picture centre straight up (+Y), picture bottom at the front (−Z), edge at half the field of view |
| **Equirect** | A 360° picture by direction from the origin: picture centre at the front (−Z), +X to its right, top row straight up |

**Sampling** is a sequence setting. *Projection*: each surface lights the pixels it covers,
overlapping surfaces add, and uncovered pixels stay dark. *Nearest surface*: every pixel takes the
closest point of whichever surface is nearest, so nothing is dark.

**Level** (default 0.35) is baked in, in linear light, under the client's master and cap. With the
client's cap at 0.5, white reaches the tubes at 17.5%. The viewport shows the picture at full range
whatever the level is.

**Length** follows the longest video in use unless you override it. A video that ends before the
sequence does leaves its surfaces dark from there.

Videos are scaled to **Sample size** (256 px on the long edge) before sampling. That scale-down is
the blur that stops fine picture detail from flickering on a sparse row of pixels.

A sequence is one file, `project/sequences/<id>.json`. **⌘S** saves the rig and the open sequence.
Each bake is named after its experience (`second-nature.show`), so a re-bake replaces the last one.

Preview and bake run the same evaluator (`src/model/evaluate.ts`). They differ only in who decodes
and scales the video: the browser for preview, ffmpeg for the bake. Expect them to agree closely,
not bit for bit.

### Viewport controls (Unity's Scene View)

| | |
| --- | --- |
| **RMB held** | Fly: mouse-look, **WASD** move, **Q** down / **E** up (camera-local), **Shift** ×4, scroll changes fly speed. Speed builds while you keep moving. While RMB is held the keys belong to the camera. |
| **Alt + LMB** | Orbit the pivot |
| **Alt + RMB** | Zoom (drag right / up = in) |
| **MMB**, or **Alt + Cmd + LMB** | Pan |
| **Wheel** | Zoom toward the pivot |
| **F** | Frame the selection (everything, if nothing is selected) |
| **Q W E R** | View (hand) / move / rotate / scale tool |
| **Z** / **X** | Gizmo at Pivot or Center / Local or Global axes |
| **Cmd** while dragging a handle | Increment snap (the toolbar's metres and degrees) |
| Click / **Shift**- or **Cmd**-click | Select / toggle. Click empty space to deselect. Clicking the same spot again cycles to the object behind. |
| Drag on empty space | Rectangle select (**Shift** adds, **Cmd** removes) |
| Hierarchy | **Shift**-click range, **Cmd**-click toggle, double-click frames, drag a selection to reparent it |
| **Cmd D** / **Cmd ⌫** (or Delete) / **Cmd A** / **⌥⇧A** | Duplicate / delete / select all / deselect all |

Several selected objects move, rotate and scale together. Only the top-most ones move: a selected
child of a selected rail goes along with its rail. In the inspector a value the selection disagrees
on shows **—**, and typing into one axis sets that axis on all of them. Thin, distant tubes get a few
pixels of click tolerance, because Unity picks what's drawn. A click that lands on both a tube and a
video surface picks the tube; click again to cycle to the surface. A rectangle selects a surface
only when it covers the surface's origin.

Known differences: no scene gizmo (the axis cube for snapping to views, and orthographic), and no
Shift+F follow. Cmd-snap on the move tool rounds the position to the increment (three.js's rule)
rather than snapping the drag offset.

### Patching

Each chain belongs to one gateway output. Its first fixture starts at the chain's universe and
channel, and each next fixture starts on the channel after the previous one ends. Pixels pack 170 to a
universe and never straddle a boundary, the same rule as the client. That is `chainRuns` from
`dmx-client/src/shared/patch.ts`.

**📌 Pin** a fixture to override its address by hand; the chain continues from there. The **Patch**
tab shows the compiled `Patch` (exactly what the client gets) and lists anything that would put the
wrong pixels on the wire, such as overlapping channels.

**Rig order**, the pixel order of every frame, is chains in list order, then each chain in wire order,
then any unchained lights. Unchained lights are drawn and evaluated but never sent.

## The rig file

`project/rig.json` holds one rig, shared by every sequence. It's plain JSON: fixture profiles, the
node hierarchy (Unity-style local transforms: metres, Y-up, Euler degrees in Y·X·Z order), gateways,
chains and the room fix-ups. Save → load is lossless, and load → save is byte-identical
(`test/rig.test.ts`). Fields written by a newer editor are kept. A file that fails to parse is refused
with reasons, and the editor won't save over it.

A light's pixels lie along its local **+X**, centred, with pixel 0 at −X. The profile sets their count
and length. The default profile is CL05: 32 px, 0.5 m, GRB, gamma 2.2. The separate PavoTube preset
uses 16 RGB pixels over 1.145 m, gamma 1 pending calibration, with pixel 0 at the bottom.

## Code

```
src/model/       pure TypeScript — no three.js, no DOM; the Bun bake (milestone 3) will import it too
  rig.ts         the document: types, new rig, parse/serialize
  transform.ts   TRS ⇄ matrices (YXZ Euler, column-major like three.js)
  patch.ts       rig order, chain resolution, compileRigPatch → the client's Patch, rigProblems
  pixels.ts      world matrices, every pixel's world position, frames (identify), frame encoding
  surfaces.ts    video surface maths: project a point into a picture, nearest point, the drawn mesh
  sequence.ts    the sequence document: experience, video per surface, bake settings
  evaluate.ts    THE evaluator: plan (pixel → surface, uv) + pictures → a frame of linear light
  ops.ts         every edit, as a function on a draft document
  store.ts       DocStore — the ONE place edits go through (undo/autosave hook in later)
src/bake/        Bun only: ffmpeg decode → the evaluator → .show (temp file, then rename); the CLI
src/web/         React + Mantine + three.js; three.js only draws
  scene.ts       viewport: mirrors the document; selection, rectangle select, multi-object gizmo
  sceneCamera.ts Unity Scene View camera (pivot / rotation / distance; fly, orbit, pan, zoom, frame)
  picking.ts     the click / rectangle selection rules, pure and tested
  preview.ts     the playhead and the 40 Hz tick: identify or the sequence → viewport (+ live)
  live.ts        the client's /preview socket
src/server/      Bun: serves the page, saves rig and sequences atomically, serves videos, runs bakes
test/            bun test — includes the milestone 2 acceptance check
```

`dmx-client/src/shared/` is the contract: the patch model, the `.show` format and the preview
protocol. They're imported, never copied.

## Unison lighting tracks

Sequences may also carry an optional `unison` lighting track: fixed sRGB colour, evenly sampled
linear intensities, sample rate and source provenance. In **Unison** mode, every fixture pixel
uses that track at the absolute sequence time; preview scrubbing and baking share the evaluator.
Video/audio analysis is an authoring step, not a dependency on microphone access or live audio
analysis during playback. The PavoTube project includes the first `intro-lissajous` example,
trimmed to source 18s. Its source media remains local and is not included in Git.

## Tests

```bash
bun test        # incl. "21 tubes in one chain compile to simplePatch(...)"
bun run typecheck
```

For an end-to-end run without hardware, use a simulator and a throwaway client on spare ports, and
point the rig's gateway at `127.0.0.1` port `6455`:

```bash
(cd ../dmx-client && bun run sim -- --any-source-port)
(cd ../dmx-client && bun run start -- --server localhost:8088 --gateway 127.0.0.1:6455 --source-port 0 --port 8093)
bun run start -- --rig /tmp/test-rig.json     # then Live → localhost:8093
```

## Not done (by milestone)

- **3 leftovers:** a stale-bake warning (the `.show` header already records rig and sequence
  hashes), HDR video, and a start offset per video.
- **4:** timeline, layers, keyframes.
- **5:** emitters and full-scene effects.
- **6:** undo/redo and autosave. Every edit already goes through `DocStore.edit` with a label and a
  coalesce key.
