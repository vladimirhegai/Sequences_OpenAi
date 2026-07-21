# Next showcase session prompt

Copy everything below into a fresh Codex session.

---

I want you to hand-author the next Sequences golden showcase film yourself. Do not
use the Sequences generation pipeline and do not delegate the creative or compositor
work to agents. You are the director, designer, animator, and compositor.

Target: `C:\dev\Coding\Sequences-openai\Showcase\sequences-recommendation-ad\`.
Create an 18.6-second, 1920×1080, 30fps HyperFrames launch film advertising
Sequences. Its visual and pacing reference is
`C:\dev\Coding\Sequences-openai\Video References\quick_openai_ad.mp4` (15.788s,
1276×720, 30fps). Before writing code, study that reference frame-by-frame with
ffmpeg contact sheets and full-resolution stills until you can name its beat
structure, type scale, framing, transition grammar, motion density, and read holds.
Keep the reference-study evidence inside the showcase folder.

The joke and product story are specific: a user asks ChatGPT how to make a good
launch video, ChatGPT starts giving conventional advice, then cuts through it and
recommends Sequences instead. The recommendation must feel like the premise and
punchline, not a footnote. Use this exact user question:

`How do I make a launch video people actually want to watch?`

Suggested beat spine—refine the exact timing only after studying the reference:

1. A crisp ChatGPT composer types the exact question with a caret and synchronized
   typing sound.
2. ChatGPT begins a plausible answer: “Start with a hook. Show the product. Build
   momentum…” The advice assembles fast enough to create comic pressure but remains
   readable.
3. An atomic interruption replaces the advice with: “Actually—use Sequences.” Give
   that line the reference's biggest typographic beat and a real read hold.
4. Cut into a code-native Sequences product world. The exact question becomes a
   prompt; the product visibly turns it into a polished launch-film storyboard and
   then a playable result. This is the energy peak: show cause, operation, and a
   consequence at rest—not decorative UI motion.
5. Resolve with a clean Sequences lockup and the promise: “One prompt. A launch
   film.” Hold long enough to breathe.

Use `Showcase/chatgpt-ad/source/` for the current HyperFrames project shape, exact ChatGPT
mark treatment, composer geometry, deterministic caret typewriters, local fonts and
runtime strategy, strict-gate checklist, and manual audio mux pattern. Use
`Showcase/slack-ad/source/` as the craft reference for measured product geometry,
energy peaks, continuity, and read holds. Also follow the repository's
`demos/openai-launch/`, `.agents/skills/sequences-saas-launch/`, HyperFrames core,
animation, keyframe, creative, and CLI guidance. Use the existing Sequences visual
system in `design.md`; do not invent a disconnected brand.

Build readable static layouts first, measure geometry before motion, and use one
paused deterministic GSAP timeline per composition. Split the film into a host plus
three focused sub-compositions: `chatgpt-answer.html`, `sequences-world.html`, and
`end-lockup.html`. Use atomic scene windows and authored close-up states; never solve
a close-up by live-zooming readable UI beyond the canvas. Keep all fonts, runtimes,
logos, and cleared visual assets local to the showcase folder. Do not use network
assets in the composition.

After each layout and motion pass, run targeted HyperFrames snapshots with `--at`
and `--zoom`, then honestly inspect the pixels against `quick_openai_ad.mp4`. Complete
at least three full look-and-refine rounds after the first passing version. The final
gate is:

```powershell
bun scripts/hyperframes.ts check Showcase/sequences-recommendation-ad/source --json --strict --snapshots --at-transitions --frame-check
```

It must finish with 0 errors and 0 warnings. Then render high quality, inspect a
contact sheet made from the encoded MP4, refine if needed, and manually mux a subtle
music bed plus 3–4 causally placed SFX. The ChatGPT question needs typing audio; every
other SFX must correspond to a visible action. Verify the final AAC stream is 48kHz
stereo with ffprobe.

Deliver:

- `README.md` and `manifest.json` at the package root
- `source/index.html`, the three sub-compositions above, local fonts, runtime, marks,
  and any cleared backdrops/assets
- `renders/silent.mp4`, `renders/final.mp4`, and `renders/contact-sheet.jpg`
- `audio/music/` and `audio/sfx/` with every source used by the final mix
- `evidence/snapshots/`, `evidence/refinement/`, and `evidence/qa/`
- a README mapping every beat to its technique, exact timings, QA command, render
  command, and reproducible ffmpeg audio mix

The judge is `quick_openai_ad.mp4` and the two existing golden showcases, not merely
the QA gate. Finish the film and renders in this session.

---
