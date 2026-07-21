# Authoring notes

## Direction

The original `artifacts/chatgpt-native-story.mp4` had the right feature arc but presented Search and Canvas as oversized graphic cards. The revision keeps that arc inside one persistent ChatGPT surface: question, answer, sources, working document, refinement, and completion. Monochrome surfaces, restrained green, thin borders, native spacing, and the exact knot replace the previous blue/orange showcase styling.

The animation is one paused GSAP timeline registered as `window.__timelines["chatgpt-native-story"]`. It uses explicit states and hard kills so every frame is deterministic under arbitrary seeking. The cursor is the standard slim 19x28 system-arrow silhouette with a white edge. Its four landing coordinates were derived from the rendered button centers with the active camera transform included; the measured click-frame tip error is 0–0.02px. Each small green ripple is nested inside its target control, so its origin cannot drift from the button.

## Beat anchors

|   Time | Event                             |
| -----: | --------------------------------- |
|   0.55 | Initial prompt begins typing      |
|  2.507 | Send click                        |
|   3.52 | ChatGPT response begins streaming |
|  8.638 | Sources click                     |
| 12.724 | Canvas click                      |
|  14.88 | Refinement prompt begins typing   |
| 16.811 | Refinement send click             |
|  17.48 | Updated document confirmation     |
|  20.53 | Product surface clears            |
|  20.94 | Knot unfurl begins                |
|  21.75 | Exact vector knot resolves        |
|  22.08 | ChatGPT promise completes         |

These points align to the analyzed `commercial-jazz` grid (approximately 117.5 BPM, first confident beat near 0.464s). See `../audio/BEAT_MAP.json` for the frame-exact ledger.

## Verification

```powershell
bun scripts/hyperframes.ts lint Showcase/chatgpt-native-story/source --json
bun scripts/hyperframes.ts check Showcase/chatgpt-native-story/source --json --strict --frame-check="severity=warning;seek=.5;tol=2" --at-transitions --snapshots
bun scripts/hyperframes.ts snapshot Showcase/chatgpt-native-story/source --at 8.5,9.0,16.7,21.15,21.45,21.7,21.9 --output Showcase/chatgpt-native-story/evidence/snapshots/pass-2
bun scripts/hyperframes.ts render Showcase/chatgpt-native-story/source --output Showcase/chatgpt-native-story/renders/silent.mp4 --quality high --strict-all --skill sequences-saas-launch
```

The final exhaustive gate passed runtime, layout, motion, frame, and WCAG contrast checks with zero errors, zero warnings, and no dropped transition samples.
