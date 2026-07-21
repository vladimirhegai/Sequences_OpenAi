# OpenAI launch-video grammar

Use when the brief asks for an OpenAI-style launch film or names these moods: minimal
type-led, kinetic typography, cosmic/starfield product theater, continuous-gradient
device story, composer/voice-pill product spot. The grammar below is distilled from
frame-level analysis of five authorized OpenAI launch spots; the repository's
`demos/openai-launch/` film demonstrates every rule inside the pinned strict gate.

## The grammar

1. **Type narrates.** Short declarative statements, one thought per beat, centered,
   large (interstitials 120–230px, section titles 48–84px), tight grotesque sans,
   black-on-white or white-on-dark. No sentence continues across a beat.
2. **The product surface is the hero.** A composer pill ("Ask anything"), an editor, a
   product window, or a device frame doing real work: deterministic caret typewriter,
   operated press with a same-instant consequence, visible agent progress
   ("Worked for 2m 30s"), a deliverable card.
3. **Device frames are props at video scale.** A phone or laptop screen state has at
   most 2–3 readable text blocks, with type at ~2× natural app size; render microcopy
   as skeleton bars.
4. **Scene alternation.** White typographic interstitials alternate with exactly one
   demonstration world per film: pure dark, subtle starfield, one continuous brand
   gradient, or a photographic backdrop. Do not mix demonstration worlds.
5. **Atomic handoffs.** Scenes swap on clip windows as cuts. The outgoing readable unit
   blur-exits inside its own clip first; never crossfade two readable text layers; never
   cover text with an expanding wipe plate.
6. **Voice and typing carry cause → effect.** Waveform bars (finite yoyo pulses), a mic
   or send orb, typed request — then the product assembles as the direct consequence,
   which is the energy peak.
7. **Floating panels, gentle cameras.** Product windows float with soft large shadows;
   camera work is a mild push (≤1.07) with a settle, on a padded world layer.
8. **Resolve by subtraction.** End on the mark (blossom-style bloom), name, one tagline,
   long read hold, near-invisible breathing scale (≈1.014 over ~2.2s). Nothing else.
   For OpenAI/ChatGPT/Codex marks, copy the exact knot geometry and bloom recipe from
   `references/codex-mark.md` — never redraw the mark from memory.

## Strict-gate survival checklist (each rule prevents a known blocking class)

- Reveal panels with `clip-path` wipes, not slides from outside a clipping container
  (`container_overflow` at sampled mid-flight frames).
- Give `back.out` entrances ~8px slack inside their clipping parent; overshoot spills
  past flush edges (`container_overflow`).
- The camera-owned world is a reserve box smaller than the root by its largest pose's
  spill (world at scale s needs (s−1)/2 of its size in margin on every side).
- Drift tiled backgrounds with `background-position`, never transforms, so the layout
  box never moves.
- After a non-linear exit tween that ends near a clip boundary, pin the state with a
  `tl.set(..., { opacity: 0 })` (`gsap_exit_missing_hard_kill`).
- Stage opening states in CSS or one-time setup `gsap.set` before registering the paused
  timeline; never park sets at timeline position 0.
- Typewriters: full-width text in an absolute wrapper, `clipPath: inset(0 0% 0 0)` with
  `steps(chars)`, caret as a separate element translated the *measured or verified*
  text width with identical easing — an estimated advance leaves the caret ahead of the
  glyph edge on screen.
- Full-frame overlays that exist at time 0 must be visibly styled at time 0
  (`gsap_fullscreen_overlay_starts_visible`); a quiet opening is valid, a blank one is
  not.
- Declare only motion assertions the film actually satisfies: every `appearsBy` time is
  at or after the element's real first visible frame, `keepsMoving` windows match real
  choreography, and every sidecar selector exists in the assembled DOM.
