# Final verification

## HyperFrames

Command:

```powershell
bun scripts/hyperframes.ts check Showcase/sequences-recommendation-ad/source --json --strict --snapshots --at-transitions --frame-check
```

Result on 2026-07-20:

- overall: pass
- lint: 0 errors, 0 warnings
- runtime: 0 errors, 0 warnings
- layout: 0 errors, 0 warnings; all transitions and tween boundaries sampled
- motion: 0 errors, 0 warnings; 300 assertion samples
- contrast: 0 errors, 0 warnings; 24 checks passed
- generated finding snapshots: none

## Semantic contracts

- `SequenceArtifactV1Schema`: pass
- `ComponentPlanV2Schema`: pass
- `sequence.json`, `index.motion.json`, `design-capsule.json`, `component-plan.json`, and `BEAT_MAP.json`: valid JSON

## Encoded deliverables

- Silent master: H.264 High, yuv420p, 1920x1080, 30fps, 23.600 seconds / 708 frames.
- Final master: same video stream plus AAC-LC, 48kHz stereo, 23.600 seconds.
- Final mix: -17.4 LUFS integrated, 2.1 LU LRA, -1.6 dBFS true peak.
- Decode verification: clean full-file ffmpeg pass.
- Encoded MP4 contact sheet plus full-resolution refusal, aligned avatar/text, hijack, morph, and final-lockup frames were inspected; no encode-specific defect was found.
