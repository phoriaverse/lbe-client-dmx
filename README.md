# LBE lighting client and editor

`dmx-client/` plays clock-synchronised lighting shows and streams editor previews through
Art-Net or an ENTTEC DMX USB Pro Mk2. `dmx-editor/` provides the 3D room/fixture editor,
video preview and `.show` baking.

The PavoTube setup uses eight Nanlite PavoTube II 30XR tubes via ENTTEC DMX OUT 1 and a
Godox TimoLink TX. It includes the office rig, a purple Unison sequence for the Lissajous
intro, fixture-brightness previews and playback controls that exit Identify/Walk.

Start with [PavoTube setup and playback](PAVOTUBE_SETUP.md). The saved intro is 26.4 seconds,
starting 18 seconds into the visual source, with a Dolby-rendered 5.1 soundtrack in the
companion MP4. Video, room model and baked show binaries are supplied separately in
`Lissajous-Intro-Lucas-2026-11-24.zip`; the setup guide lists where to put them.

For the general tools, see the [client README](dmx-client/README.md) and
[editor README](dmx-editor/README.md). Both use Bun; physical USB output also needs Node.js,
and baking needs FFmpeg/FFprobe. Each app provides `bun test` and `bun run typecheck`.
The client's normal tests use local UDP sockets; the real-USB test is opt-in and requires
exclusive access to the adapter.

The full Introduction now uses the [build-13 eight-tube score](scores/onboarding-v1/VENUE-INTEGRATION.md).
It previews independently of the black screen video and retains the approved 5.1 timing.
The short Lissajous rehearsal remains a separate preset.

The [full-show 1.1 integration](scores/full-show-v1.1/VENUE-INTEGRATION.md) adds Trent's selected
B scores for Second Nature, The Shape of Memory and Sit Around The Fire, plus Gentle White
Waves for the 30-second captioned Onboarding video. Run `bun run scores:install` in `dmx-client`
for standalone deployment, or `bun run prepare:full` in the matched display checkout to update
the full rehearsal. Both integration branches are `feature/full-show-dmx-1-1`.

For a 3D simulation, run `bun run import:full` then `bun run start:pavotube` in `dmx-editor`.
At http://localhost:8092, open **Sequence**, choose a **v1.1** preset and press **Play**.
Keep **Live** off; no DMX hardware is required. **Sound** plays the matching local rehearsal
audio if prepared. The importer preserves existing editor presets and deployed shows.
