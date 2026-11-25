# SoundSpace LBE — Eight-tube onboarding score 1.0.0

Source experience: standalone SoundSpace LBE 0.13.0 / build 13. Created 25 November 2026.

A separate lighting feed for eight Nanlite PavoTube II 30XR tubes. Includes native `.show` files for `phoriaverse/lbe-client-dmx`, an end-to-end video with reference audio, a scrubbable HTML preview, editable authoring source, source envelopes and stage-local data. No headset rebuild is needed to review the lighting.

## Start here

1. Watch `preview/Eight-Tube-Onboarding-v1.mp4`, or open `preview/Preview.html` locally and press Play. The first 10 seconds show the waiting loop; intro time zero is video time 00:10.
2. Use `native/introduction.show` for the **full 210.65-second onboarding**, starting at Play Intro. It includes the 150-second intro, ceiling flight/reveal and Bass Mosaic return/tail.
3. `native/ambient.show` is the gentle 10-second pre-intro rain loop. `native/vr-idle.show` is the separate 20-second purple passive-room loop.
4. Follow `INTEGRATION.md` before using the files with the existing journey. The repo's current 26.4-second Lucas clip has different timing; do not replace that show's media alone and expect synchronization.

The lighting has passed software compatibility checks against the repo's actual parser, patch compiler and output code. This score has not been sent through the physical ENTTEC/tubes. Optical appearance, CRMX latency and headset-to-DMX synchronization remain to be tested.

## Authored behavior

- CH25 / Atmos_Obj_15 onsets produce descending rain heads, soft trails and a bottom-pixel splatter, distributed deterministically among eight tubes. Drop travel starts 1.35 seconds before the analyzed onset so its landing meets the spike. Tube assignment is artistic, not an ADM position reconstruction.
- Rain starts gently, builds from intro 11–31 seconds, fades from 71–79 seconds. CH23 / Atmos_Obj_13 gives the cloud wash a subdued breath.
- Lightning accents occur at 39.94, 40.84, 41.74 and 42.64 seconds: left, right, left, both. They are authored 0.5-second pulses, not fixture strobe commands.
- CH15 / Atmos_Obj_5 summons the waveform at 42.64 seconds, over a three-second ramp.
- Purple, pink and white crests move across the tube row. Six curve forms cycle twice; their transitions blend over approximately 3.90 seconds. These are lighting interpretations of the forms, not a geometric recording of the actual curve.
- CH31 kick envelope (18/s attack, 9/s release) plus mix RMS drives crest width, vertical excursion and energy. Calm moments reduce movement and light.
- The ceiling flight sweeps upward. Room reveal sweeps down into an aurora wash. Bass Mosaic plays through its authored section and 15-second tail, fading over its final four seconds into quiet purple idle lighting.

## Timeline

Times below are relative to Play Intro, not the preview's waiting section.

| Stage | Start | Duration |
| --- | ---: | ---: |
| Intro / rain / waveform | 0.00 | 150.00 |
| Ceiling flight | 150.00 | 4.30 |
| Room reveal | 154.30 | 17.00 nominal |
| Aurora arrival | 171.30 | 3.00 |
| Return delay | 174.30 | 0.75 |
| Bass Mosaic / tail | 175.05 | 35.60 |
| Passive room | 210.65 | looping |

The full preview is 240.65 seconds: 10 seconds waiting + 210.65 seconds main + 20 seconds passive. The app's room reveal can wait on geometry completion; the fixed native show uses the nominal 17-second reveal. Use stage clocks for an exact match when that duration varies.

## Hardware

Matches the supplied [PAVOTUBE_SETUP.md](https://github.com/phoriaverse/lbe-client-dmx/blob/main/PAVOTUBE_SETUP.md): Mac → ENTTEC USB Pro Mk2 OUT 1 → TimoLink TX → CRMX. No Art-Net node is required. Universe 1 is the software output name. RGB8 / 16 pixels / 48 channels per tube; start addresses 1, 49, 97, 145, 193, 241, 289, 337. Pixel 1 bottom, 16 top. Channels 385–512 remain zero. Tubes use Linear dimming, profile gamma 2.2. Client master 1, cap 0.5, 40 fps.

The preview lays logical tubes 1–8 side by side as requested. The office rig positions are preserved in `hardware/rig.office.json`; its physical arrangement is 3–2–1 at the screen, 4/8 midway and 5–6–7 at the rear. Thus a row wave is not a literal left-to-right sweep of the entire office. Reorder spatial sampling in the authoring script if adapting this cue to room coordinates.

Native samples are 16-bit with transfer 2.2, preserving low-level authored precision before the client's final RGB8 output. The fixture output remains 8-bit. Authored master 0.8 is baked; the client's 50% cap is applied separately. Preview estimates linear light after that cap and DMX quantization, encoded to sRGB. It is not a brightness calibration.

## Tune and regenerate

`settings.json`: master, rainGain, waveGain, rainFallSeconds, seed, stage durations, form order and fps. Detailed palette, motion, onset schedule and envelope weighting live in `src/generate.py`. Changing duration alone does not retime the music or hard-coded musical cues; edit these together.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python src/generate.py
python src/export_native.py
python tests/test_feed.py
node --experimental-transform-types tests/test_native.mjs
```

Preview rendering additionally needs ffmpeg on PATH and a suitable font; see `src/make_preview.py`. The included reference audio already matches this nominal sequence. Rebuild the audio mix if timings change. Tests write to stdout; `tests/*results.txt` contains this release's results.

## Contents and validation

- `native/`: full intro, waiting, passive and individual stage `.show` files, hashes in index.json.
- `data/`: 40 Hz RGB8 linear intensity frames, RGB16 power-encoded samples, JSONL feed, metrics/cue timeline, source onset/RMS envelopes.
- `hardware/`: repo setup snapshot, original office rig and compiled patch.
- `src/`: authoring/export, generic feed reader, optional ArtDmx test adapter and preview renderer.
- `unity/`: optional stage-clock sender scaffold; not installed or compiled into the app.
- `tests/`: 12 feed tests plus native parser/output verification over 19,252 frames, including patch boundaries, unused-slot zeros, cap, blackout and truncated-file rejection. Native output peak under cap is DMX 128.
- `reference/`: unchanged client source used by compatibility tests, pinned to commit `4e95dac4393a1c66a4fbd344ebccac7ad39cda33`. Node test adapts only import extensions in a temporary runtime copy.

The review audio is a mono timing mix, not an Atmos/Dolby or spatial reproduction. It omits some app SFX and uses one reference idle clip instead of the app's randomized idle pool. No new server journey, device install, physical lighting test or live clock bridge is claimed by this package.
