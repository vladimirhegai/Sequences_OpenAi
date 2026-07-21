# Sequences recommendation launch film

A hand-authored 23.6-second launch film for Sequences. ChatGPT receives the question "How do I make a launch video people actually want to watch?" and types a coherent response. The user then types "Can you make a launch film"; ChatGPT begins "No, as an AI agent, I cannot directly help you—" before the response is visibly hijacked into a Sequences recommendation. The same request becomes a locked storyboard and a verified playable result before the promise: "One prompt. A launch film."

The revision uses a ChatGPT-native visual language: warm-neutral fields, white conversation surfaces, dark ink, restrained OpenAI green, rounded controls, and the animated knot. It is an original Sequences film inspired by those product conventions, not a claim that Sequences is an OpenAI product.

| Property      | Value                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Frame         | 1920x1080, 30fps                                                                                                             |
| Duration      | 23.600 seconds / 708 frames                                                                                                  |
| Engine        | HyperFrames with deterministic paused GSAP timelines                                                                         |
| Music         | `happy_comercial.mp3`, catalog ID `happy-commercial`                                                                         |
| Final         | [`renders/sequences-recommendation-ad-final.mp4`](renders/sequences-recommendation-ad-final.mp4)                             |
| Silent master | [`renders/sequences-recommendation-ad-silent.mp4`](renders/sequences-recommendation-ad-silent.mp4)                           |
| Contact sheet | [`renders/sequences-recommendation-ad-final-contact-sheet.jpg`](renders/sequences-recommendation-ad-final-contact-sheet.jpg) |
| Beat map      | [`audio/BEAT_MAP.json`](audio/BEAT_MAP.json)                                                                                 |
| Manifest      | [`manifest.json`](manifest.json)                                                                                             |

## Package

- `source/`: host composition, three focused subcompositions, semantic contracts, motion assertions, fonts, and the local knot sprite.
- `audio/`: requested music master, three SFX sources, derived final AAC mix, 30fps beat map, and exact four-window typing/click mix notes.
- `renders/`: verified silent master, final audio/video master, and contact sheets generated from the encoded MP4s.
- `evidence/refinement/user-openai-sync-pass/`: exact beat snapshots and contact sheets for the redesigned cut.
- `evidence/qa/`: encoded refusal/glitch frame inspections, waveform, and final gate summary.

## Reproduce

Run from `C:\dev\Coding\Sequences-openai`.

```powershell
bun scripts/hyperframes.ts check Showcase/sequences-recommendation-ad/source --json --strict --snapshots --at-transitions --frame-check
bun scripts/hyperframes.ts render Showcase/sequences-recommendation-ad/source --quality high --output Showcase/sequences-recommendation-ad/renders/sequences-recommendation-ad-silent.mp4
```

The exact local ffmpeg audio mix and verification commands are in [`source/AUTHORING.md`](source/AUTHORING.md). The delivered final is ffprobe-verified H.264 High plus AAC-LC, 48kHz stereo.

## Provenance

- The composition and Sequences product surfaces are code-native and original to this package.
- Montserrat, IBM Plex Mono, GSAP, and HyperFrames runtime assets come from the repository's existing fixtures and showcases.
- The 25-frame knot sprite is the authorized local sequence already used by `Showcase/chatgpt-ad`; its final state resolves to the canonical vector mark documented in the launch skill.
- `happy_comercial.mp3` is the exact requested local catalog master, copied from `vendor/audio/music/happy_comercial.mp3` with SHA-256 `4e6182ef59452bf0ab01646af3d86480f10e9d71173cadac6623636374860bed`.
- `typing.wav` and `mouse_click.wav` are local showcase SFX. `glitch.wav` is a reproducible ffmpeg synthesis documented in the mix notes.
