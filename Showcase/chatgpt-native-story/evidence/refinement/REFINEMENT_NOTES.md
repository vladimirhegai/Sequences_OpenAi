# Refinement record

## Source audit

- Located the old artifact at `artifacts/chatgpt-native-story.mp4`: 20 seconds, 1920x1080, 30fps, no audio.
- Recovered the source lineage from `data/projects/release-a` at commit `96166e8ab3f716b6ff26c3b8aa8102c0ff522651`.
- Preserved the useful Search → Sources → Canvas story while rejecting the oversized blue Search pill, orange/blue full-screen stages, approximate logo glyphs, and dashboard-like shell.

## Pass 1

- Rebuilt the film as a persistent, native-feeling ChatGPT conversation.
- Added coherent typed user input and streamed assistant copy.
- Added source cards, Canvas rewrite, working-document status, and a 24-second jazz-aligned structure.
- Added the authorized 25-frame knot unfurl resolving to the exact vector mark.

## Pass 2

- Reflowed the conversation left as the Sources panel opens, eliminating transient occlusion.
- Reduced the cursor from a presentation-scale white arrow to a compact black pointer with white outline and subtle shadow.
- Reduced click rings and changed them to restrained ChatGPT green.
- Corrected the final UI-to-lockup seam with a deterministic visibility hard kill.
- Fixed all runtime selectors, motion assertions, contrast misses, and transient layout findings.

## Exit state

- Exhaustive strict check: passed.
- Runtime/layout/motion/contrast warnings: 0.
- Dropped transition samples: 0.
- Encoded video: 720 frames, H.264 High, 1920x1080, 30fps.
- Encoded audio: AAC-LC, 48kHz stereo, -15.3 LUFS integrated, -1.3 dBFS true peak.

## Cursor correction

- Replaced the custom 30x38 triangle with the standard slim 19x28 system-arrow shape used by the existing Slack showcase.
- Measured the live rendered center of all four targets at their exact click timestamps, including parent and camera transforms.
- Re-authored the pointer destinations to place the arrow hotspot at each target center. Measured error: home 0px, Sources 0.02px, Canvas 0.02px, refine 0px.
- Nested each click ripple inside its control and added the previously missing Canvas ripple, eliminating independent stage coordinates.
- Re-ran the exhaustive strict gate and re-rendered/re-muxed the 720-frame final.
