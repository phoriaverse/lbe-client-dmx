# Full-show lighting integration — 26 November 2026

Integrated from [Trent's Slack handoff](https://team-phoria.slack.com/archives/C0BHY7SBT63/p1795652795047619)
and its [integration specification](https://app.notion.com/p/42469192f39881ecb7b6cc7d9b4731fd).
The original 53 package files and their `SHA256SUMS.txt` are retained unchanged in this directory.
The ZIP's SHA-256 is `9a7f8272adcc4e22927d36f488f0156bb99636ec2bbe91e784807a4cc892fe9c`.

The venue patch matches the delivery: eight 16-pixel RGB tubes, bottom to top, universe 1 at
1/49/97/145/193/241/289/337, gamma 2.2, ENTTEC OUT 1 through TimoLink TX. Room positions match
the established office rig; the installer checks the address/drive contract without replacing it.
Master remains 1 and cap 0.5. Introduction, Seating, ambient and the short Lissajous preset are preserved.

| Journey state | Treatment | Duration | Peak DMX at the venue levels |
| --- | --- | ---: | ---: |
| Onboarding | Gentle White Waves | 30.000 s | 22/255 |
| Second Nature | B — Chromatic Rapids | 195.000 s | 98/255 |
| The Shape of Memory | B — Neural Current | 278.275 s | 113/255 |
| Sit Around The Fire | B — Rising Embers | 506.050 s | 56/255 |

`scripts/full-show-release.ts` validates source hashes, timings and the current rig before copying
the native scores. It uses the live server's capitalization for `Sit Around The Fire.show`;
the original packaged file and every deployed payload retain their published hashes. Selection
uses the whole filename stem, not the header's experience text. Changed prior payloads are backed
up outside the media folders and complete new files are published by atomic rename.

From `dmx-client`, run `bun run scores:install` to populate both `media/` and `shows/`. For the
full Mac rehearsal, use the sibling display repo on `feature/full-show-dmx-1-1` and run
`bun run prepare:full`; it installs the four scores alongside Introduction in `media/full-show/lighting`
and the matched captioned video as `media/full-show/Onboarding.mp4`. Then use `bun run rehearse:full`.
Existing clients rescan on the next journey visit. Reconnect ENTTEC and restart the launcher if
the USB transport has failed; a failed/disconnected adapter cannot output a show.

The onboarding video is silent, 30 seconds and 1600 × 800, preserving its aspect ratio. The
three music videos remain black with the previously aligned 5.1 soundtracks. Lighting starts
at the shared server timestamp and fades to black slightly before the room media ends
(0.400 s / 0.075 s / 0.100 s respectively). Completion waits for every participant, preserving
the complete audio tails. No Quest or iPad app rebuild is needed for these data files.

These are pre-baked scores. Their Python authoring source/settings and review movie are retained
here; they are not added as editable timeline-keyframe sequences in the web editor. The existing
Introduction and short rehearsal editor presets are unchanged.

Validation: every one of the 40,373 frames passes through the current client's parser, patch and
output with a fake transport and matches the delivered DMX preview bytes. Tests cover frame caps,
unused slots, black first/final frames, stop/blackout, file integrity and reversible installation.
The display integration test runs the real server and player vote lifecycles, checking shared
start times and waiting for the screen after lighting completion, including the Onboarding/Doffing gate.

All pre-existing local MP4s and shows retained their hashes. Physical perceived brightness,
CRMX latency and final headset/room alignment remain on-site checks; Second Nature's previously
documented audio alignment still needs audition. At integration time the ENTTEC was unplugged,
so no physical fixture test is claimed. The original handoff validation is separate from these checks.
