# SoundSpace — Selected B + Onboarding White

**DMX content release 1.1.0 · 26 November 2026 · ready for integration review**

Trent selected variation **B** for all three music tracks. Those files are byte-for-byte identical to the reviewed A/B v1 release: no additional brightness increase. This package adds a separate **30-second Gentle White Waves score for the captioned onboarding instructions video**.

## What to send

Send this entire ZIP to the DMX integrator. It contains four deployable native `.show` files, fixture mapping, settings, source, checksums and a full onboarding preview. These are lighting data for [lbe-client-dmx](https://github.com/phoriaverse/lbe-client-dmx), shared by the AVP/Quest installation; they do not require a headset app rebuild. No production service, repository or fixture was changed by this delivery.

[Drive release folder](https://drive.google.com/drive/folders/1k-K6QJWLuKHHU1tlb2yoGECodOmkHsTk)

| Server journey state / filename stem | Deployable file | Selected look | Lighting duration | Matching media duration |
| --- | --- | --- | ---: | ---: |
| The Shape of Memory | `media/The Shape of Memory.show` | B · Neural Current | 278.275 s | 278.266667 s |
| Sit Around the Fire | `media/Sit Around the Fire.show` | B · Rising Embers | 506.050 s | 506.033333 s |
| Second Nature | `media/Second Nature.show` | B · Chromatic Rapids | 195.000 s | 195.000 s |
| Onboarding | `media/Onboarding.show` | Gentle White Waves | 30.000 s | 30.000 s |

The first three scores continue the source-footage colour and sound-driven designs already reviewed: front-to-side/rear colour travel, stronger moving crests for TSOM, rising warm embers for SATF, and opposing colour/current waves for Second Nature. The lengths are full cuts, not highlights. TSOM includes timeline-verified live neural passages and the final cue; provenance is in `authoring-b/analysis/`.

## Install in the DMX client

1. Preserve the existing four same-named scores outside the active media folder so they can be restored.
2. Copy the **contents of this package's `media/`** into the existing DMX client's configured media directory. Keep the exact server state names, including spaces. Filename matching is case-insensitive; the header's `experience` field does not select a journey state. If the deployment uses renamed states, rename the files to match that deployment explicitly.
3. **Keep `Introduction.show`, `Seating.show` and `ambient.show` unchanged.** `Onboarding` means the instructional display video. `Introduction` means the separate MR/Lissajous sequence. This release does not replace or merge those sequences.
4. Use the matching display cuts listed above. In particular, `Onboarding.show` is matched to **Sound-Space-Onboarding-Captioned-30s-V01.mp4**, the video Trent shared with Lucas on 24 November. A verified copy is in `reference/`; it contains captions and **no audio stream**. Do not substitute the separate Lucas onboarding draft or an atmospheric playblast without retiming the score.
5. Retain the existing server-clock start, client master **1.0**, cap **0.5**, blackout and stop handling. Do not start these on an independent timer. Current session completion uses score duration, so a differently timed instructions cut must be rebaked; an arbitrary loop is not a substitute.
6. Rehearse the four journey states in simulated output first, then check the installed tubes for pixel order, perceived white balance/brightness and CRMX latency. Confirm the instructions finish with the video and the subsequent `Introduction` retains its own lighting.

All files are 40 Hz, non-looping `LBESHOW1`, 16-bit power-encoded RGB samples with transfer 2.2. The first and last frames are black, with baked entry/exit fades. Track playback time zero is score time zero. Rounding to a complete 40 Hz frame adds less than 25 ms for the two non-integral cuts.

## New instructional lighting

Open **`preview/Onboarding-Gentle-White-Waves.mp4`**. It shows the actual 30-second instructions, a top-down fixture layout and all 16 pixels in each of the eight tubes. The preview is silent because the supplied video is silent; no narration was invented.

- Neutral **RGB-mixed white**, using the established RGB pixel mode; it does not address a dedicated CCT/white channel.
- A broad wave travels gradually around the eight tubes over a **12-second cycle**, with gentle vertical movement.
- A low white floor keeps the room settled while captions change; there are no per-word flashes, strobes or abrupt card-change hits.
- **2.5-second fade in**, **3-second fade out**. The score finishes at exactly 30 seconds.
- At master 1 / cap 0.5, the maximum output is **22/255 DMX** and the largest change is **one DMX code per 25 ms frame**. This is an electrical output value, not a measurement of fixture luminance.

`onboarding-settings.json` exposes floor, peak, wave period, vertical travel, spread and fades. This is a deliberate restrained supporting treatment while instructions are read. A fixture test can establish the preferred room brightness without changing the three selected B scores.

## Fixture contract

Eight **PavoTube II 30XR**, RGB8 / 16-pixel mode, 48 channels per tube. Universe 1 starts: **1, 49, 97, 145, 193, 241, 289, 337**. Pixel 1 is bottom and 16 is top. Slots 385–512 stay zero. ENTTEC USB Pro Mk2 OUT 1 → TimoLink TX → CRMX. Tube dimming Linear; profile gamma 2.2.

Office layout: screen/front **3–2–1**, side tubes **4/8**, rear **5–6–7**. Included positions are the existing estimated layout, not a new survey. See `hardware/patch.native.json`, `positions.json` and the [repo fixture setup](https://github.com/phoriaverse/lbe-client-dmx/blob/main/PAVOTUBE_SETUP.md).

## Earlier B review videos

These existing movies compare A on the left with the **selected B on the right**. No need to re-download the older A scores for integration.

- [One-minute comparison](https://drive.google.com/file/d/18UZiduGIgYOAQ-zv5LAZXCN9f395F2W1/view)
- [Full TSOM](https://drive.google.com/file/d/1wmNw3iTeTgIurQMima6tBl4q2iz1q6n-/view)
- [Full SATF](https://drive.google.com/file/d/16i3HznDxrm-Z78amL9sMsiyIprSslh-N/view)
- [Full Second Nature](https://drive.google.com/file/d/1miSEmV0GqJKPJfZnYNFVRa-zLnwrTNin/view)

## Validation and fine tuning

`tests/native-output.txt` records the actual DMX client's parser, patch and output code processing **40,373 frames**. Every frame matched the packaged `.dmx8` preview data. Additional checks cover start/end blackout, all eight fixture boundaries, cap, unused channels, truncated input rejection, source hashes, durations, neutral white, smoothness and full video decoding. `tests/metrics.json` records the results. Native references are retained unchanged with source URLs in `reference/SOURCES.json`; the test adapts only TypeScript import extensions in a temporary runtime. Tests use a fake transport and do not transmit DMX.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
node --experimental-transform-types tests/test_native.mjs
python tests/test_scores.py
```

Native tests require Node 24; media checks use FFmpeg/ffprobe. Set `FFMPEG`, `FFPROBE` and `PREVIEW_FONT` if needed on another machine. The default font is macOS Arial.

To author a new instructions revision, edit `onboarding-settings.json`, then run `python source/generate_onboarding.py` and `python source/render_onboarding.py`. The generator updates the `Onboarding` manifest record only. Re-test and release with new checksums; do not overwrite this frozen handoff. If changing duration, supply the matching video and update its source metadata too. Tests intentionally assert the 30-second cut in this release.

`authoring-b/` contains the unchanged earlier generator, reusable measured analysis arrays and settings, including both A/B authoring logic for provenance. Running its generator produces study files inside that authoring folder, not the deployed `media/` selection. Full-resolution music videos and large sampling proxies are omitted. Re-analysis requires the original sources documented there; the supplied arrays are enough to rebake the lighting curves.

## Outstanding on-site checks

Physical tube output, optical colour/brightness, CRMX timing, and the complete production server/display/headset flow have **not** been validated by this package. The preview depicts computed output, not a camera recording of the room. No fixture activation or deployment was performed.

The instruction source is evidenced by [Trent's Slack attachment](https://team-phoria.slack.com/archives/C0BHY7SBT63/p1795510546267199); its hash is in the manifest. Client state/timing behavior was checked against `lbe-client-dmx/dmx-client/src/session.ts` and the [display client's documentation](https://github.com/phoriaverse/lbe-client-display/blob/main/README.md).
