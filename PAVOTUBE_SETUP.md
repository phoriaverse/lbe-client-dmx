# PavoTube room setup

This preset controls eight Nanlite PavoTube II 30XR tubes through:

**Mac → USB → ENTTEC DMX USB Pro Mk2 DMX OUT 1 → DMX cable → Godox TimoLink TX → CRMX → tubes.**

No Art-Net node or network alias is required for this route. The client supports the public
ENTTEC Pro/API1 protocol on **DMX OUT 1 only**. The Mk2's second output/API2 is not implemented.
Universe **1** is the software patch name mapped to OUT 1; it does not select OUT 2.

## The patch

Use the tubes' **RGB, 8-bit, 16-pixel** DMX mode: exactly **48 channels per tube**, RGB repeated,
without extra dimmer, CCT, white or strobe channels. Keep the working CRMX links to the TimoLink TX.
The software does not change the tubes' mode, address or pairing remotely.

| Tube | Start address | Channel range | Position x, z (metres) |
| --- | --- | --- | --- |
| 1 | 1 | 1–48 | 5.553, 1.900 |
| 2 | 49 | 49–96 | 5.880, 4.026 |
| 3 | 97 | 97–144 | 6.795, 5.731 |
| 4 | 145 | 145–192 | 8.119, 6.677 |
| 5 | 193 | 193–240 | 9.587, 6.677 |
| 6 | 241 | 241–288 | 10.911, 5.731 |
| 7 | 289 | 289–336 | 11.826, 4.026 |
| 8 | 337 | 337–384 | 12.153, 1.900 |

All eight are on universe 1. Tube pixel **1 is bottom, 16 is top** (the editor calls these 0–15).
Pixel p starts at `1 + 48*(tube-1) + 3*(p-1)`, followed by red, green, blue. Channels 385–512
are zero. Tubes 1 and 8 are now the two ends nearest the screen in the simulator.

The addresses come from the user's previously working TouchDesigner patch. The positions above
were updated on 26 November 2026 to the requested horseshoe in front of the imported atrium
screen, open towards the screen. Tubes 1–8 follow the curve from left to right when facing
the screen; the footprint is about 6.6 m wide and 4.8 m deep. These are simulator placements,
not surveyed physical positions. They supersede the earlier rectangular eight-circle layout.
The DMX patch and each tube's recorded animation are unchanged.

The supplied `phoria-atrium-walls-2m.glb` is stored in `dmx-editor/models/` (gitignored). It uses
metres and Y-up. Overall bounds are about 14.75 × 3.26 × 9.56 m; the floor interior is about
14.345 × 9.162 m. Room offset `[-3.7985, -0.231, 3.363]` places the floor surface at y = 0 and its
front-left extent at x/z = 0. Scale remains 1 and rotation remains zero. The model's screen is
at the low-z end. Copy the model with the project when moving it to another Mac.

Vertical placement is an assumption: tubes stand on the floor, with centre y = 0.5725 m and nominal
length 1.145 m. Adjust the height in the editor if they are on stands. On 24 November 2026 the user
checked one tube and confirmed **DMX DIM CURVE: Linear**. The shared profile now uses **gamma 2.2**,
which makes this client's DMX drive proportional to linear light. Set/check all eight tubes to
**Linear**; their individual optical response has not been measured. Output latency is **0 ms,
unmeasured**. The client starts with master 100%, cap 50%, and 40 fps.

### Comparing brightness ramps

On the client page, **Linear-light ramp** uses equal output-light steps; **Perceptual ramp** uses
CIE L* spacing as an approximate equal-perceived-brightness 0–1 interpolation. Both run from the
bottom pixel to the top and reach the same peak at the same Pattern level. The old Ramp used a
straight ramp in encoded show samples, with an uncalibrated gamma-1 profile. Do not compare it
to the new buttons as though the old percentage represented calibrated light output.

**Estimated light** predicts the active fixture response from the actual quantised DMX values,
then encodes it as sRGB for the screen. **DMX values** shows raw code swatches; pointing at a pixel
shows its RGB bytes. The editor also respects sequence level, client master/cap, channel gains
and 8-bit output steps, instead of boosting dim previews. Its viewport previews the editor's
sequence/Identify, not test patterns running in the client. When disconnected it assumes
master × cap = 100% and labels that as offline.

Screen and lamp luminance, room adaptation, glare and camera exposure differ, so this is a
relative preview, not a photometric calibration. At low levels 8-bit DMX repeats steps near
black; baking at 16-bit cannot remove the final 8-bit fixture-mode limit. A future change to a
16-bit fixture mode would require a different channel patch/universe plan.

## Two Introduction presets

This integration starts from Lucas's `main` at `4e95dac`. The existing short rehearsal is preserved,
and the journey now has a separate full-length Introduction:

| Editor sequence | Length | Baked file | Companion screen/audio |
| --- | --- | --- | --- |
| **Intro Lissajous · from 18s** | 26.4 s | `dmx-client/shows/intro-lissajous.show` | Original square video with Dolby-rendered 5.1 |
| **SoundSpace Introduction · full timeline** | 210.66 s | `dmx-client/shows/introduction.show` | Square timing guide with mono reference audio |

For either preset, launch the editor as below, choose its name in the sequence selector, enable
**Sound** if desired, then **Play**. Leave **Live** off for simulation. To drive tubes, run the USB
client, confirm its output label and enable **Live**. Playback automatically stops Identify/Walk;
clear any client blackout or test pattern first. The editor's Sound toggle routes the selected
companion audio through the browser; the full Introduction's guide is not a production soundtrack.

### Full SoundSpace Introduction

The new sequence follows the Quest Introduction at commit `8611d7f`: rain/steam from zero,
waveform at 42.64 s, ceiling swell at 150 s, aurora at 171.3 s, Bass Mosaic at 174.3 s, then black
at the end. All 128 pixels share purple **#9002FF**. The envelope combines the actual Timeline
audio stems and scene gains with authored visual activation/alpha curves, smoothed with an
80 ms attack and 250 ms release. Entry and exit fades are 2 s and 1.5 s. This is an initial
lighting interpretation for rehearsal; optical brightness and wireless latency remain uncalibrated.

To regenerate from the sibling Quest source and materialized Git LFS audio, with ffmpeg on PATH:

```sh
cd /Users/phill/Repos/LBE/lbe-client-dmx/dmx-editor
bun run create:introduction
```

This writes the editable `project/pavotube/sequences/soundspace-introduction.json`, source hashes
and cue timings in `project/pavotube/introduction-timing.json`, the guide video in `media/`, and
the bake in `../dmx-client/shows/introduction.show`. It also deploys a copy to
`../dmx-client/media/introduction.show`, which the journey selects by filename. It preserves the
short rehearsal JSON, video and show. The generated binaries remain gitignored; regenerate or
copy them when moving to another machine. The rig's room model remains a separate asset.

The bake contains 8,426 frames at 40 fps (210.650 s, 10 ms below the source endpoint). Both ends
are black. Time zero is the Quest Timeline's zero; the short rehearsal's 18-second source trim
does not apply to this preset. `SoundSpace_Introduction_Lighting_Guide.mp4` is a labelled timing
visualization with a mono stem mix, not a render of the Quest scene or a Dolby 5.1 re-render.

For coordinated playback, start exactly one web or iPad server, the Quest app and the DMX client
without `--standalone`, then enter **Introduction**. Their prepared barrier and shared `startAt`
align the full show. The server maps optional flat-screen content to `introduction.mp4`; supply an
actual matching full-length video separately if using a display/iPad screen. The timing guide is
only selected in the editor and is not installed as production display content. New full-length
hardware/Quest sync has not yet been exercised in the room.

### Short Lissajous rehearsal

The rig and editable sequence are tracked in Git. To use the current video and room model,
use these assets from `Lissajous-Intro-Lucas-2026-11-24.zip` in this checkout:

- `dmx-editor/media/Lisajous_Curve_2_From18s_Square_5.1.mp4`
- `dmx-editor/models/phoria-atrium-walls-2m.glb`
- `dmx-client/shows/intro-lissajous.show` for the short standalone rehearsal.

These binary assets are intentionally excluded from Git. The ZIP also includes a matching
source snapshot and its own launch instructions.

The saved **Intro Lissajous · from 18s** sequence plays a 26.4-second, 720 × 720 copy of
`Lisajous_Curve_2.mp4` (the updated 44.4-second source), beginning at source time 18 seconds. The source's aspect is preserved
inside the square with narrow black side padding. The square surface is centred on the model's
screen. The original source, including the first 18-second waiting section, is in repo-root
`media/`; the playback copy is in `dmx-editor/media/`.

All eight tubes and all their pixels use the same sampled purple, **#9002FF**. A pre-analysed
40 Hz track combines lower-image water brightness, upper-image curve brightness and mono audio
RMS, with 40 ms attack / 180 ms release, a 150 ms entry fade and a 500 ms ending fade. The updated
cut retains the existing intensity values up to the final half-second, where the ending fade
now reaches black at the shorter endpoint. The retained audio matches the original exactly,
as do the sampled video frames; no timing offset was introduced. This is a first
artistic pass, not a calibrated loudness or colour match. Sequence level is 0.35; under the
current 50% client cap the measured bake peaks at DMX 34 on the blue channel.

Select the sequence, enable **Sound** and **Live**, then **Play**. Play (or Space) automatically
stops Identify / Walk the chain. Identify pauses the sequence while checking a selected tube;
it is not a sequence playback control. Live must be enabled to send the sequence to the tubes
(it resets off when the page reloads). Sequence time zero is already
source time 18s. The client must have no test pattern or blackout active. The baked lighting file
is `dmx-client/shows/intro-lissajous.show`, experience **Intro Lissajous**, 1056 frames at 40 fps.
The journey's Introduction state now selects the separate full-length show. The rehearsal show contains lighting only.
Editor preview plays the companion video and audio.

To regenerate the authored intensity track after changing its weights, run
`bun src/tools/create-lissajous.ts` from `dmx-editor/`, then
`bun run bake -- intro-lissajous --rig project/pavotube/rig.json`. The script expects the existing
trimmed playback file `Lisajous_Curve_2_From18s_Square_5.1.mp4` and re-analyses the named sequence
(normalisation may shift when analysing a different-length cut). Changing the sequence Level does not
require analysing again, but does require re-baking for standalone show playback.

### Dolby-rendered 5.1 audio

The current playback file is `dmx-editor/media/Lisajous_Curve_2_From18s_Square_5.1.mp4`.
Its H.264 video stream is copied unchanged from the square stereo version. Its only audio
stream is six-channel AAC-LC, 48 kHz, encoded at 768 kb/s; it is selected by default.

Dolby Atmos Renderer exported the supplied **Max Cooper - Bass Mosaic 2026-04-30 ADM-BWF.wav**
using **5.1 / All beds and objects / Multichannel interleaved / Entire master**. The complete,
unaltered 24-bit/48 kHz, 258.25-second export is retained at
`media/dolby-renders/Bass_Mosaic_Dolby_re-render 02.wav`. FFprobe reports the layout as 5.1
(L, R, C, LFE, Ls, Rs). This is a metadata-aware Dolby re-render, not a direct mix of the
ADM's 24 audio tracks.

Alignment against the clip's existing stereo soundtrack gave the best practical match at
99% playback speed plus 210.75 ms of leading silence. The resampling changes rate and pitch
together, uniformly across all six channels. This is an estimated alignment between different
mixes, not a sample-exact null match. At the chosen alignment, the 10 ms RMS-envelope comparison
over clip seconds 1–24 peaks at zero offset with correlation 0.865 (versus 0.665 before rate
alignment). The aligned PCM excerpt is retained as `media/dolby-renders/Intro_Lissajous_Aligned_5.1.wav`.
It ends at 26.4 seconds with a 10 ms edge fade. The lighting envelope and video timing are unchanged.

To reproduce the aligned excerpt and mux from the repo root (use new filenames if outputs exist):

```sh
ffmpeg -i 'media/dolby-renders/Bass_Mosaic_Dolby_re-render 02.wav' \
  -af 'asetrate=47520,aresample=48000,adelay=10116S:all=1,apad,atrim=duration=26.4,afade=t=out:st=26.39:d=0.01' \
  -c:a pcm_s24le -n media/dolby-renders/Intro_Lissajous_Aligned_5.1.wav
ffmpeg -i dmx-editor/media/Lisajous_Curve_2_From18s_Square.mp4 \
  -i media/dolby-renders/Intro_Lissajous_Aligned_5.1.wav \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 768k -ar 48000 \
  -disposition:a:0 default -movflags +faststart -n \
  dmx-editor/media/Lisajous_Curve_2_From18s_Square_5.1.mp4
```

The Mac's default output was verified as Audient ORIA at 48 kHz, with the first six outputs
labelled L, R, C, LFE, Ls, Rs. The editor uses the browser's video-element audio output; actual
speaker reproduction still depends on the browser and device route. All six encoded channels
were checked for signal and unclipped peaks. Video-payload SHA-256 matches the stereo original.

## Start the visual editor without hardware

Install Bun and Node.js first; `node` must be on PATH for USB access. The native serial library
runs in a small Node worker because opening it directly in Bun 1.4.0 crashes on macOS.

Run in two terminals:

```bash
cd /Users/phill/Repos/LBE/lbe-client-dmx/dmx-client
bun install --frozen-lockfile
bun run preview:pavotube
```

```bash
cd /Users/phill/Repos/LBE/lbe-client-dmx/dmx-editor
bun install --frozen-lockfile
bun run start:pavotube
```

Open the **[editor](http://127.0.0.1:8092)** and **[client controls](http://127.0.0.1:8091)**.
Preview mode opens no USB device or Art-Net output socket and does not join an LBE server.
The editor's Live tab explicitly shows **Preview only — no hardware output**.

The editor includes 3D fixture placement, profiles, DMX patching, Identify/Walk the chain,
video surfaces, live sampling and baking `.show` files. It has no finished keyframe timeline,
undo/redo or autosave yet. Use **Save / Cmd-S**. A desktop-sized browser window is most useful;
use **Frame all**, **Frame selected**, or double-click a tube in the left list to focus it.
The rig is framed automatically on load. **F** also frames the selection, or the whole rig when
nothing is selected. **Q** switches to the view tool and hides the move/rotate handles.

The two launch commands share [rig.json](dmx-editor/project/pavotube/rig.json) as the address source.
Editor preview and baked shows carry their own updated patch. Restart the client after saving rig
changes to refresh the patch used by its built-in test patterns. The original CL05 project remains
separate. The PavoTube intro sequence is tracked; its media and baked show are supplied in the handoff ZIP.

## Switch to real USB output

1. Connect the ENTTEC and use its breakout's **DMX OUT 1** to feed the TimoLink TX. Ensure the
   transmitter and eight tubes are powered, paired and set to the patch above.
2. Close TouchDesigner or any other application using this USB interface. Stop the preview client
   with Ctrl-C before starting the hardware client on the same control port.
3. Enumerate devices without opening them:

   ```bash
   cd /Users/phill/Repos/LBE/lbe-client-dmx/dmx-client
   bun run usb:list
   ```

4. Start a local hardware check using the actual path printed by that command:

   ```bash
   bun run start:pavotube -- --usb-device /dev/tty.usbserial-REPLACE_ME --standalone
   ```

   A uniquely identifiable ENTTEC can be selected automatically by omitting `--usb-device`.
   Generic FTDI adapters require an explicit path; the client will not guess among them. It opens
   the VCP exclusively, checks for a Pro parameter reply, preserves DMX break/MAB settings, sets
   40 fps and sends an initial blackout. A missing device or failed handshake stops startup.

5. In the editor's **Live** tab, confirm an ENTTEC output label. Select Tube 1 and use **Identify**:
   only that tube should blink dim white, with its bottom pixel red. **Walk the chain** checks
   tubes 1–8. Stop Identify, then use the client control page's Red, Health check (green), Blue,
   Boundaries and chase patterns to verify colours and bottom-to-top order. Boundaries should
   show red at each bottom and blue at each top. A test sequence has been sent through the actual
   ENTTEC, and the user reported that the repeated test looked good.

For show operation, omit `--standalone` and optionally add `--server HOST:PORT` to use the selected
LBE server. Copy the bake to `dmx-client/media/` using the journey state name, for example
`introduction.show`. Keep spaces in multiword state names.

To remember the device path, create a gitignored `dmx-client/config.pavotube.local.json`:

```json
{ "usbDevice": "/dev/tty.usbserial-REPLACE_ME" }
```

The control page preserves that entry when saving its master slider. Environment alternatives are
`LBE_LIGHTING_CONFIG`, `LBE_LIGHTING_OUTPUT` and `LBE_LIGHTING_USB_DEVICE`.

## Failure behaviour and limits

- A show or preview for another gateway or universe is rejected rather than folded into this
  output. One TimoLink carries one universe. An incompatible show reports ready without lighting,
  following the client's existing missing-show behaviour.
- Serial writes keep the latest frame under backpressure; they do not accumulate an old show.
- Disconnects and failed writes appear in the control page and editor. Reconnect and restart the
  client after resolving the problem; there is no automatic USB reconnection.
- Normal shutdown sends black after queued frames. If USB is unplugged or the process is killed
  forcibly, software cannot guarantee a blackout; the interface/fixtures may hold their last look.
- If the port does not enumerate, check the ENTTEC VCP setup for the OS. No system driver is
  installed by this change. If a Pro handshake fails after using another app's Mk2 API2 mode,
  close that app and power-cycle the Mk2 before retrying.

## Verification and protocol sources

Integration verification on 25 November 2026: 57 client tests (one opt-in hardware test skipped),
56 editor tests and both TypeScript checks passed. The new bake matches editor evaluation, is
uniform across all 128 pixels, and preserves the rehearsal hash. The actual preview-only client
loaded the full show over the journey protocol, sought into Bass Mosaic, completed, blacked out
and cancelled on a new visit. The editor displayed both presets and played the full guide against
the room model. This integration did not open USB or run a new physical lighting test.

Verified in software: 56 client tests (plus one opt-in hardware test skipped), 51 editor tests, both TypeScript checks, native serial
enumeration, and editor Identify through the no-hardware preview client. USB tests emulate
handshake replies, exact serial frames, backpressure, failure and final blackout; they also verify
the 384 channel mapping and bottom-to-top coordinates.

On 24 November 2026 the connected ENTTEC `ENXE723K` passed a real handshake, writes, drain and
close test. Dim red/green/blue, boundary markers and a tube chase were sent without USB errors,
then blackout. The user reported that the repeated test looked good. End-to-end CRMX latency is not yet measured.

Two macOS issues were resolved during that test: serialport's native open crashes inside Bun, so
USB now runs in a Node subprocess; and a 57600 virtual baud rate caused ~109 ms drain waits.
The worker uses 1000000 virtual baud (~8 ms measured drains), keeping full-frame writes and final
blackout drained while allowing 40 fps. This is the USB driver's virtual setting, not the physical
DMX line rate; ENTTEC documents it as a dummy baud value.

The real-device regression is opt-in, emits only black, and requires exclusive device access:

```bash
LBE_TEST_USB_DEVICE=/dev/tty.usbserial-ENXE723K bun test test/usb-hardware.test.ts
```

It verifies the real handshake and close, and at least 35 completed writes from 40 paced frames,
so the slow-drain regression cannot silently pass. The ordinary test suite skips this test.

The driver sends label 6 with a 513-byte payload: zero DMX start code, then 512 channels, framed
as `7E 06 01 02 00 [512 channels] E7`. Parameter messages use labels 3 and 4. Sources:

- [ENTTEC Mk2 datasheet](https://cdn.enttec.com/pdf/assets/70314/70314_DMX_USB_PRO_MK2_DATASHEET.pdf)
- [ENTTEC Pro API specification](https://cdn.enttec.com/pdf/assets/70304/70304_DMX_USB_PRO_API.pdf)
- [ENTTEC Mk2 API support](https://support.enttec.com/legacy-product/dmx-usb-pro-mk2-70314/dmx-usb-pro-mk2-api)
- [QLC+ ENTTEC implementation](https://github.com/mcallegari/qlcplus/blob/master/plugins/dmxusb/src/enttecdmxusbpro.cpp)
- [Nanlite product and manuals](https://nanliteus.com/products/pavotube-ii-30xr-4-rgbww-led-pixel-tube-with-built-in-crmx)
- [Nanlite DMX Reference Guide, RGB 8-bit section, printed pp. 121–122](https://cdn.shopify.com/s/files/1/0550/4886/3944/files/1695717084985-621686-1124121241519342-PavoTube_II_15XR_30XR_60XR_DMX_REFERENCE_GUIDE_EN.pdf?v=1697009862)
- [Godox catalogue, TimoLink TX/RX](https://www.godox.com/Downloads/Godox_Continuous_Lighting_Catalogue_EN.pdf)
