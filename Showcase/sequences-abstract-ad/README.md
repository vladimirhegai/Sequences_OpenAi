# Sequences abstract ad

Made by Sequences, this package contains the finished 30.333-second launch film
**Make your prompt move.**, plus the approved preproduction, reusable component
lab, reference study, exact music map, source composition, and verification
evidence.

## Package map

- `PLAN.md` — durable creative direction, reference study, music map, story,
  palette, motion rules, and production gates.
- `reference/` — curated stills and compact contact sheets from both supplied
  reference films, with takeaways recorded beside them.
- `audio/music/` — the frozen local violin track used for the final timing map.
- `.media/audio/sfx/` — the frozen local typing, click, whoosh, pop, and impact
  kit; cue timing lives in `source/story/sfx-cue-sheet.md`.
- `source/` — deterministic HyperFrames final-film composition; the approved
  component lab remains at `source/compositions/component-lab.html`, with the
  readable final motion source beside it in `final-film-motion.js`.
- `components/strip/` — full-resolution component proof frames and the master
  review sheet.
- `evidence/` — component and final-film snapshots plus QA notes.
- `renders/sequences-abstract-ad.mp4` — final 1080p H.264/AAC master.
- `source/snapshots/contact-sheet.jpg` — encoded-film overview.

## Current phase

1. Story and design direction: locked on disk.
2. Components: authored, strict-check clean, and approved.
3. Full video: continuity-polished, strict-check clean, rendered,
   music-and-SFX mixed, and checked at −16.5 LUFS / −1.5 dBFS true peak.

## Final-film commands

From the repository root:

```powershell
npx hyperframes lint Showcase/sequences-abstract-ad/source
npx hyperframes check Showcase/sequences-abstract-ad/source --strict
npx hyperframes snapshot Showcase/sequences-abstract-ad/source --at 0,1.69,2.4,3.1,3.7,5.05,6.2,7.8,9.6,11.8,12.3,15.17,17.8,18.54,21.91,23.8,25.28,26.8,27.5,28.6,29.52,30.2
npx hyperframes render Showcase/sequences-abstract-ad/source --quality high --fps 30 --strict-all
```
