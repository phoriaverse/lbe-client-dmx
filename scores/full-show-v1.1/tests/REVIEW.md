# Release 1.1 review evidence

- Native client parser/patch/output: 40,373 frames across all four scores; exact DMX byte equality with previews; cap, boundary channels, blackout, unused channels and truncation checks passed.
- Selected B SHA-256 values match the previous reviewed release, despite deployment filename changes.
- Instructions: source fetched from Trent's 24 November Slack attachment F0CL115TAQ7. ffprobe confirms 30.000 seconds, 900 video frames at 30 fps, 1600×800, and no audio stream.
- White score: 1,200 frames at 40 Hz, 30.000 seconds, equal RGB throughout, peak DMX 22 with cap 0.5, maximum adjacent-frame change 1. Moving spatial phase and persistent white floor verified.
- Complete source and preview video decoding passed. Review preview: 600 frames at 20 fps, 1280×720, 30.000 seconds.
- Visual review: captions remain readable; the source is not cropped; eight numbered tubes show broad white crests, with a top-down view preserving front 3–2–1 and rear 5–6–7. The white output is deliberately subdued. No source-card flash is copied into the lights.
- No physical lights driven, no optical calibration, no CRMX latency measurement, no production deployment.
