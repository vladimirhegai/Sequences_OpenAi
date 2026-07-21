# Component-lab QA

Verified on 2026-07-20 with the repository-pinned HyperFrames CLI (0.7.56).

## Commands

```powershell
bun scripts/hyperframes.ts lint Showcase/sequences-abstract-ad/source --json
bun scripts/hyperframes.ts check Showcase/sequences-abstract-ad/source --json --strict
bun scripts/hyperframes.ts snapshot Showcase/sequences-abstract-ad/source --at 1.1,3.4,5.2,7.1,9.2,11.2,13.2,15.7,17.2,19.2,21.6,23.75,25.5 --no-end --output Showcase/sequences-abstract-ad/components/strip/proof-frames --describe false
```

## Result

- overall strict check: passed;
- lint errors / warnings: 0 / 0;
- runtime errors: 0;
- layout errors: 0;
- motion errors: 0;
- contrast errors / warnings: 0 / 0;
- selected visual proof frames: 13.

The layout analyzer reports only informational intentional clipping/occlusion
inside the oversized glyph, progress track, and collage tiles. No final video was
rendered or assembled during this phase.
