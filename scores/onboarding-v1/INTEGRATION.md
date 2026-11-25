# Integration with lbe-client-dmx

## Fixed timeline: native client route

Use the existing client's `.show` loader and ENTTEC transport. This package does not replace or modify those systems.

For a dedicated full-onboarding test, keep a backup of any existing `introduction.show`, then copy `native/introduction.show` into the client's media directory. The existing client chooses files by journey-state filename, so the full onboarding must be paired with a matching **210.65-second Introduction state/video**. This file is unrelated to the existing 26.4-second Lucas cut. Keep that cue separately.

Use `native/ambient.show` before starting the intro. `native/vr-idle.show` requires its own matching journey state/file mapping after the reveal; the client will not infer a VR idle state from this filename. Do not use the pre-intro rain loop as the post-reveal passive cue. The fixed intro contains no audio: audio/video and the lighting must share the server's start timestamp. Keep the repo's existing operator controls, brightness cap and blackout behavior.

To view the client without hardware, follow the repo's `bun run preview:pavotube` route. The independent HTML/MP4 preview in this package needs no services and plays the new complete score immediately. The repo's editor will not automatically expose this Python-authored score as an editable native keyframe sequence; rebake through the supplied source or import its frame data in a future editor adapter.

## Variable reveal: stage-local data route

For an app reveal that waits on geometry completion, a fixed bake alone cannot guarantee sync. Use `native/stages/` or `data/<stage>.rgb8` against the current app stage clock, changing stages only when the app does. Hold the final reveal frame while waiting; jump to the aurora stage on the actual completion event. Never advance by accumulating frame deltas.

Stage IDs: waiting, intro, rise, reveal, aurora, return_delay, bass, idle; blackout is all zero. Source stage clock starts at zero for each transition. Pause holds; seek indexes directly; restart changes session ID. Loop only waiting and idle.

`unity/LbeLightingClock.cs` illustrates the app-side clock message. `src/feed.py` resolves RGB8 frames from it. Neither is wired into the headset app or the ENTTEC client yet. The optional `src/play.py` sends ArtDmx only when explicitly enabled for a confirmed external Art-Net patch; **it is not the office ENTTEC route**. Its default example patch is a virtual universe-0 testing patch. Do not point it at TimoLink or treat it as a USB driver.

Clock messages: `{ "session":"visit-id", "sequence":1, "stage":"intro", "seconds":42.64, "playing":true }`. At least 20 Hz updates are expected; the optional bridge blacks out after 0.5 seconds without updates. LAN and serial latency are currently unmeasured. Production integration should use the existing LBE server clock and ENTTEC output code, rather than adding an independent free-running timer.

## First hardware review

Check the documented RGB8 / 16-pixel mode, Linear curve and addresses; retain the 50% cap. Use the repo's Identify/boundary checks to confirm bottom/top order. Then compare CH25 landing, CH15 summon and CH31 kick to the matching video/audio. Measure the output delay before applying an offset. Native parser/output tests establish byte compatibility, not physical CRMX timing or fixture luminance.
