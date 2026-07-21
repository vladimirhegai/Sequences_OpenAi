# ChatGPT launch ad

Made by Sequences: a ChatGPT launch film in the grammar of
`bold_openai_ad.mp4`.

## Package

| Property         | Value                                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| Duration         | 27.6 seconds                                                                   |
| Frame            | 1920×1080 at 30fps                                                             |
| Engine           | HyperFrames with deterministic paused GSAP timelines                           |
| Website render   | [`renders/final.mp4`](renders/final.mp4)                                       |
| Contact sheet    | [`evidence/snapshots/contact-sheet.jpg`](evidence/snapshots/contact-sheet.jpg) |
| Machine metadata | [`manifest.json`](manifest.json)                                               |

## Layout

| Directory              | Contents                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `source/`              | HyperFrames host, three sub-compositions, fonts, runtime, backdrops, and ChatGPT mark assets |
| `renders/`             | Standardized final, silent, and contact-sheet outputs                                        |
| `audio/music/`         | Music bed used by the final mix                                                              |
| `audio/sfx/`           | Typing, click, woosh, and notification sources                                               |
| `evidence/snapshots/`  | Full-film HyperFrames review frames                                                          |
| `evidence/refinement/` | Targeted click-alignment and end-lockup studies                                              |
| `evidence/qa/`         | Verification record and reproducible gate                                                    |

The full beat map and motion lessons are in
[`source/AUTHORING.md`](source/AUTHORING.md).

## Reproduce

Run from the repository root:

```powershell
bun scripts/hyperframes.ts check Showcase/chatgpt-ad/source --json --strict --snapshots --at-transitions --frame-check
bun scripts/hyperframes.ts render Showcase/chatgpt-ad/source --quality high --workers 1 --output Showcase/chatgpt-ad/renders/silent.mp4
```

The exact local-only ffmpeg mix command is documented in `source/AUTHORING.md`.
The final is ffprobe-verified H.264 plus AAC 48kHz stereo.
