# Showcase

Golden Sequences films packaged for website playback and implementation-agent
reference. Every showcase uses the same contract.

## Package contract

```text
<showcase-id>/
├── README.md
├── manifest.json
├── source/          Authored project and local visual dependencies
├── renders/         final.mp4, silent.mp4, contact-sheet.jpg
├── audio/           music/ and sfx/ source files
└── evidence/        snapshots/, refinement/, and qa/
```

`renders/final.mp4` is always the website-ready version. `source/` is always the
directory an implementation agent should study or execute. The manifest provides
stable machine-readable paths and media metadata.

## Catalog

| Showcase                                                          | Format                                  | Final                                                                                  | Source                                         |
| ----------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [ChatGPT launch ad](chatgpt-ad/README.md)                         | HyperFrames · 27.6s · 1920×1080 · 30fps | [final.mp4](chatgpt-ad/renders/final.mp4)                                              | [source/](chatgpt-ad/source/)                  |
| [Slack launch ad](slack-ad/README.md)                             | Paused GSAP · 28s · 1920×1080 · 30fps   | [final.mp4](slack-ad/renders/final.mp4)                                                | [source/](slack-ad/source/)                    |
| [Sequences recommendation](sequences-recommendation-ad/README.md) | HyperFrames · 23.6s · 1920×1080 · 30fps | [final.mp4](sequences-recommendation-ad/renders/sequences-recommendation-ad-final.mp4) | [source/](sequences-recommendation-ad/source/) |
| [ChatGPT native story](chatgpt-native-story/README.md)            | HyperFrames · 24s · 1920×1080 · 30fps   | [final.mp4](chatgpt-native-story/renders/final.mp4)                                    | [source/](chatgpt-native-story/source/)        |

The Slack package retains its complete authored source, audio, 24 representative
frames, contact sheet, temporal strip, and QA report. Only its regenerable 840-frame
PNG render cache is omitted (about 962 MB).

The ready-to-paste brief for the next film is
[`NEXT_SHOWCASE_PROMPT.md`](NEXT_SHOWCASE_PROMPT.md).
