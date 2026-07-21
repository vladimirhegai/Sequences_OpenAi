# Codex · OpenAI launch-grammar reference film

A 20-second HyperFrames film made through Sequences (`index.html` plus
`compositions/app-world.html`) that demonstrates the **OpenAI launch-video
grammar** distilled from five reference spots studied during production. It
passes the pinned strict gate with zero errors and zero warnings
(`bun scripts/hyperframes.ts check demos/openai-launch --json --strict
--snapshots --at-transitions --frame-check`) and renders with
`bun scripts/hyperframes.ts render demos/openai-launch --quality draft --workers 1
--output artifacts/openai-launch-reference.mp4`.

This is a **grammar reference**, like the golden Slack demo is a craft reference: study the
techniques, not the palette or copy.

## The OpenAI launch grammar (from the five reference videos)

1. **Type is the narrator.** Short declarative statements, one thought per beat, centered,
   huge (140–230px), grotesque sans, black on white. No voiceover dependency.
2. **The product surface is the hero.** A real composer pill ("Ask anything"), a real
   product window, deterministic typing with a caret, an operated press with a visible
   consequence. Never generic marketing cards.
3. **Scene alternation.** White typographic interstitials alternate with product
   demonstration worlds (dark editor, starfield theater, continuous brand gradient).
   Handoffs are **atomic cuts** on clip windows — never crossfades of two readable layers.
4. **One backdrop world per demonstration.** Pure white, pure dark, a starfield, or one
   continuous gradient. Product windows float with soft shadows and gentle pushes.
5. **Voice and typing motifs.** Waveform bars, mic pills, caret typewriters — the request
   is the story's cause; the assembling product is its effect.
6. **The lockup resolves by subtraction.** Blossom-style mark blooms, name plus one
   tagline, long read hold, near-invisible breathing scale. Nothing else on frame.

## Beat map (what to study where)

| Beat           | Time      | Technique demonstrated                                                                                                                                                       |
| -------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor hook    | 0–3.7     | Caret-riding clip-path typewriter (`steps(n)` pair), anticipation blink, read hold                                                                                           |
| Kinetic type   | 3.7–7.4   | Blur-in/blur-out word swaps, strictly sequential (one readable word at a time), hard-kill sets at exits                                                                      |
| Voice composer | 7.4–11.3  | Heading + pill hierarchy, finite yoyo waveform, typewriter, operated press (press/release + ripple), exit as one readable unit                                               |
| App assembly   | 11.3–16.5 | Sub-composition mount, clip-path panel reveals (no slide-in overflow), padded camera reserve for the 1.07 push, double shockwave peak, state-swap consequence (streak 12→13) |
| Lockup         | 16.5–20   | Six-petal blossom bloom (`back.out(1.7)` stagger), name + tagline rise, breathing lockup to the end                                                                          |

## Strict-gate lessons encoded here (learned while making it pass)

- **Atomic handoffs.** Crossfading scenes puts two readable text layers on screen and
  fails `content_overlap` / `text_occluded`. Cut on clip windows; blur-exit the outgoing
  readable unit _inside its own clip_ first.
- **No full-screen occluding wipes.** An expanding plate that covers text triggers
  `text_occluded` at sampled boundaries. Prefer cuts; carry identity with color/shape,
  not with a cover.
- **Reveal with clip-path, not slide-from-outside.** Slide-ins from beyond a clipping
  container are `container_overflow` at sampled mid-flight frames.
- **Overshoot needs margin.** `back.out` entrance overshoot (~3%) must fit inside the
  clipping parent; leave 8+ px of slack on edge-adjacent panels.
- **Padded camera reserve.** The camera-owned world layer must be smaller than the root
  by its largest pose's spill, or the push itself is `container_overflow`.
- **Drift tiled backgrounds by background-position**, not transforms, so the layout box
  never moves.
- **Hard-kill exits at clip boundaries.** A non-linear exit tween ending near the boundary
  needs a `tl.set(..., { opacity: 0 })` pin (`gsap_exit_missing_hard_kill`).
- **Stage opening states in CSS or setup-time `gsap.set`**, never as timeline-position-0
  sets.

## Assets

Fonts (Montserrat, IBM Plex Mono) and vendor runtimes are copied from
`fixtures/release-a/assets`. A production OpenAI-style film should bundle a closer
OpenAI-Sans-adjacent grotesque (e.g. Inter) as a local asset; the grammar, not the exact
typeface, is what this demo teaches. The blossom is six rotated rounded-rect petals in
pure CSS — OpenAI assets are cleared for hackathon use, so a real SVG mark may replace it
in candidate films.
