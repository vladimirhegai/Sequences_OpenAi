# QA

`report.json` contains the 24 timestamped safe-frame measurements and representative
frame hashes. Its `safeFrame.ok` result is `true`.

Regenerate the representative frames, contact sheet, temporal strip, and report with:

```powershell
bun run --cwd Showcase/slack-ad/source snapshot
```

The final render is 28.000 seconds, 1920×1080 at 30fps. Its audio stream is AAC,
44.1kHz, stereo.
