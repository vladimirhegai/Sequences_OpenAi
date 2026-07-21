# Slack launch ad

The original hand-authored Slack golden film, normalized to the shared Showcase
package contract.

## Package

| Property         | Value                                                              |
| ---------------- | ------------------------------------------------------------------ |
| Duration         | 28 seconds                                                         |
| Frame            | 1920×1080 at 30fps                                                 |
| Engine           | Deterministic paused GSAP timeline with a local Puppeteer renderer |
| Website render   | [`renders/final.mp4`](renders/final.mp4)                           |
| Silent render    | [`renders/silent.mp4`](renders/silent.mp4)                         |
| Contact sheet    | [`renders/contact-sheet.jpg`](renders/contact-sheet.jpg)           |
| Machine metadata | [`manifest.json`](manifest.json)                                   |

## Layout

| Directory              | Contents                                                                      |
| ---------------------- | ----------------------------------------------------------------------------- |
| `source/`              | Authored HTML, CSS, timeline, renderer, storyboard, local GSAP, and wallpaper |
| `renders/`             | Standardized final, silent, and contact-sheet outputs                         |
| `audio/music/`         | Music bed used by the final mix                                               |
| `audio/sfx/`           | Typing, click, mouth-pop, and woosh sources                                   |
| `evidence/snapshots/`  | 24 representative review frames                                               |
| `evidence/refinement/` | Temporal-strip review image                                                   |
| `evidence/qa/`         | Safe-frame report and render records                                          |

This historic golden predates the current HyperFrames `data-*` contract. Its paused
timeline, measured geometry, energy peak, continuity, and read holds remain the craft
reference; use the ChatGPT package for the current HyperFrames project shape.

## Reproduce

Run from `C:\dev\Coding\Sequences-openai`:

```powershell
bun install --cwd Showcase/slack-ad/source
bun run --cwd Showcase/slack-ad/source snapshot
bun run --cwd Showcase/slack-ad/source render
```

The renderer writes directly into the standardized `renders/` and `evidence/`
directories. `render` also creates `evidence/render-frames/`; that cache can be
discarded after a successful encode. The included website render is H.264 plus AAC
44.1kHz stereo.
