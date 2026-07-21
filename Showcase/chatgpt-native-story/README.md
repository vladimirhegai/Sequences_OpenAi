# ChatGPT native story

Made by Sequences, this 24-second product film turns a ChatGPT conversation into
a sourced, editable backyard plan. The UI is a native conversation surface, the
answer streams coherently, Sources behaves like an inspecting side panel,
Canvas performs the rewrite, and the film resolves through the animated ChatGPT
knot.

| Property      | Value                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- |
| Frame         | 1920x1080, 30fps                                                                             |
| Duration      | 24.000 seconds / 720 frames                                                                  |
| Engine        | HyperFrames with one deterministic paused GSAP timeline                                      |
| Music         | `commercial_jazz.mp3`, catalog ID `commercial-jazz`                                          |
| Final         | [`renders/final.mp4`](renders/final.mp4)                                                     |
| Contact sheet | [`evidence/snapshots/pass-2/contact-sheet.jpg`](evidence/snapshots/pass-2/contact-sheet.jpg) |
| Beat map      | [`audio/BEAT_MAP.json`](audio/BEAT_MAP.json)                                                 |
| Manifest      | [`manifest.json`](manifest.json)                                                             |

## Story

1. The user types: “Plan a backyard I can actually finish this weekend.”
2. ChatGPT searches, streams a useful answer, and exposes six sources.
3. Sources opens as a native side panel while the conversation reflows.
4. The answer moves into Canvas; the user asks for a one-Saturday version.
5. Canvas rewrites the working draft and confirms the update.
6. The UI clears into an animated knot and canonical ChatGPT lockup.

## Package

- `source/`: the host, focused composition, semantic contracts, local fonts/runtime, and authorized knot sprite.
- `audio/`: the requested music master, four SFX sources, derived AAC mix, beat map, and mix notes.
- `renders/`: verified silent master, website-ready audio/video master, and final contact sheet.
- `evidence/`: authored snapshots, refinement notes, exhaustive strict-check result, and encoded-frame review.

## Reproduce

Run from the repository root:

```powershell
bun scripts/hyperframes.ts check Showcase/chatgpt-native-story/source --json --strict --frame-check="severity=warning;seek=.5;tol=2" --at-transitions --snapshots
bun scripts/hyperframes.ts render Showcase/chatgpt-native-story/source --output Showcase/chatgpt-native-story/renders/silent.mp4 --quality high --strict-all --skill sequences-saas-launch
```

The exact audio placements and ffmpeg mux are documented in [`audio/MIX_NOTES.md`](audio/MIX_NOTES.md). The final is ffprobe-verified H.264 High plus AAC-LC, 48kHz stereo.

## Provenance

- The film was made through the Sequences Codex/HyperFrames workflow and retained
  as a finished pipeline example.
- The 25-frame knot sprite is the authorized local sequence from `Showcase/chatgpt-ad`; its final state resolves to the canonical vector mark.
- `commercial_jazz.mp3` is the exact requested catalog master copied from `vendor/audio/music/commercial_jazz.mp3`, SHA-256 `842a8d072a059d9d9e1280282e9ea24eda04b92c6fe2146f367e6b000ef01d81`.
- The UI is an original code-native recreation informed by ChatGPT interaction conventions; it is not a capture or a claim about unreleased product behavior.
