# Venue Introduction integration

The build-13 Notion score now drives `soundspace-introduction` in the PavoTube editor and
`introduction.show` in both room rehearsal variants. The independent 26.4-second
`intro-lissajous` rehearsal is unchanged.

The venue uses a fixed, server-clocked 210.66-second Unity Timeline. Lighting contains
8,426 complete frames (210.65 seconds at 40 Hz). The original score's 0.75-second
return delay was removed so Bass Mosaic starts at **174.3 seconds**, matching the
approved 5.1 audio. Its quiet last frame is held for the extra 0.75 seconds of tail.
No audio, reverb, room placement, fixture addresses or brightness settings were changed.

The editor's **SoundSpace Introduction · eight PavoTubes (build 13 score)** sequence
uses Recorded score sampling. Play/scrub works without USB; turn Live on only to
send it to the lighting client. A server-owned journey takes priority over editor
output. The local black 5.1 Introduction is assigned to the screen when available.
Lighting is independent of the screen: removing its video does not remove the score.

The sequence contains a self-contained RGB16 recording and named fixture mapping.
Level and placement remain editable; individual choreography is authored with the
Python source here, rather than editable timeline keyframes. Reordering the wire
chain preserves tube identity; changing its pixel count is rejected.

To restore playback from git, run in `dmx-editor`:

```sh
bun run bake -- soundspace-introduction --rig project/pavotube/rig.json
```

Then run `bun run prepare:full` in the sibling `lbe-client-display` repo to refresh
both rehearsal folders. Start with the usual `rehearse:introduction` or `rehearse:full`.
The bake needs no video/ffmpeg for lighting; the room audio still needs its existing media.

To retune, install `requirements.txt` in a virtual environment, run
`python src/generate.py` and `python src/export_native.py` from this score folder,
then run from `dmx-editor`:

```sh
bun src/tools/import-onboarding.ts ../scores/onboarding-v1 --rebaked
```

Without `--rebaked`, the importer requires the published native file's SHA-256.
Its source package ZIP SHA-256 is
`7c94aad054244dfdcc88a9ee8bebe7453d814e6981b6d9be1bef1ca1cbd48dc4`.
See `project/pavotube/onboarding-score.json` for provenance and timing adjustments.

The source's waiting and VR-idle loops are retained as separate authoring stages.
They are not assigned to journey states by this Introduction update. Geometry-gated
standalone reveals would require stage events; the current venue Timeline has fixed timing.

Validation: all 8,426 frames pass real parser/patch/output and editor round-trip checks,
including gamma 2.2, master 1, cap 0.5, universe 1, unused-slot zeros and blackout.
Physical CRMX latency and visual brightness still require an in-room audition.
