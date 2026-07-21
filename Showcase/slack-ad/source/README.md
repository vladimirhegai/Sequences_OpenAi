# Slack demo ad

An isolated, deterministic source project for the hackathon demo film. It recreates the supplied Slack UI references as editable DOM with fictional content and uses one seekable GSAP master timeline.

```powershell
bun run snapshot
bun run render
bun x tsx render.ts --render --resume
```

Outputs are regenerated in the surrounding showcase package: representative stills
under `../evidence/snapshots`, QA under `../evidence/qa`, review images under
`../renders` and `../evidence/refinement`, and the silent render at
`../renders/silent.mp4`. `--resume` preserves existing evidence, fills every
missing/empty frame, recycles the browser periodically, and refuses to encode until
all 840 frames are present. The source has no network or audio dependency.
