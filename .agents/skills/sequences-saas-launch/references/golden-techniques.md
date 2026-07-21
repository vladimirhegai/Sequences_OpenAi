# Golden-demo techniques, HyperFrames-native

Concrete craft distilled from the hand-authored 28-second golden demo (618
lines that outperformed every generated film). Use the techniques, not its
palette, copy, or legacy runtime. Everything here compiles to ordinary
seek-safe GSAP inside one registered paused timeline.

## Measure geometry, then animate

The demo measures every load-bearing rect at identity transform before any
tween exists, and derives motion from those measurements:

```js
// Collapse targets: exact per-element deltas to one convergence point.
const suckTargets = cards.map((el) => {
  const r = el.getBoundingClientRect();
  return { el, dx: CX - (r.left + r.width / 2), dy: CY - (r.top + r.height / 2) };
});
// Docking: the mark flies into a reserved inline slot measured at rest.
const dock = { x: slotCenterX - markCenterX, y: slotCenterY - markCenterY };
```

Never guess travel distances or eyeball a landing. Measure once at rest
(before the timeline runs), bake the numbers, keep the timeline deterministic.

## Solve the camera from the focal point

One world element owns the camera transform inside a clipped viewport. To land
focal point Q (world coordinates at rest) on screen point P at scale s:

```js
const camAt = (qx, qy, px, py, s) => ({
  x: px - W / 2 - (qx - W / 2) * s,
  y: py - H / 2 - (qy - H / 2) * s,
});
// mild push (1.12x) on the cause, 2.3x superzoom on the payoff target
tl.to(
  world,
  {
    ...camAt(target.left + 60, target.top + 14, 830, 540, 2.3),
    scale: 2.3,
    duration: 0.62,
    ease: "power3.inOut",
  },
  t,
);
```

The golden camera phrase: mild push on the cause → dive to the payoff →
pan with the action (e.g. ride typed text: `x: "-=" + textWidth * scale * 0.68`)
→ hold at full zoom for a read beat → pull back to a settled frame. Give the
world padded reserve so the largest pose never drags readable UI off-canvas.

## Typewriters whose caret rides the text

The golden demo revealed typed text discretely with `steps(text.length)` so a
caret physically rides the text edge. The donor animated width; this pipeline
hard-fails layout-property tweens, so use the equivalent clip + transform pair:
lay the text out at full width inside an absolutely positioned wrapper, then
reveal with `clipPath` and move a separate caret element with the same easing:

```js
const w = Math.ceil(textEl.getBoundingClientRect().width); // measured at rest
tl.to(
  textEl,
  { clipPath: "inset(0 0% 0 0)", duration: 0.95, ease: `steps(${text.length})` },
  t,
).fromTo(caret, { x: 0 }, { x: w, duration: 0.95, ease: `steps(${text.length})` }, t);
```

Start from `clip-path: inset(0 100% 0 0)` in CSS. Both tweens share one
duration and easing, so the caret lands on each glyph boundary exactly. Blink
the caret with timed opacity sets, and always blink it once in the empty field
_before_ typing starts — anticipation makes the beat legible.

## The energy peak is cause-and-effect at one point

The demo's peak works because everything converges to a single point and the
brand mark blooms from that same point — the mess literally becomes the
product:

- Suck-in: every clutter element travels its measured delta with
  `power4.in`, slight alternating rotation, tight stagger (~0.03s per item).
- Shockwave: one or two expanding rings fired from the convergence point.
- Bloom: the mark's parts start collapsed at the same point and spring out
  with `back.out(1.7)` and small stagger; a 1.025 → 1.0 settle finishes it.
- Overlap all three phases; dead frames between them kill the peak.

## Operated pointer grammar

One pointer, one intentional arrival, and a consequence in the same instant:
approach with `power3.inOut` (~0.6s), press as `scale: .82, duration: .1,
power2.in`, release as `scale: 1, duration: .2, back.out(2)` — and the pressed
control mirrors the same press/settle timing so cause is visible. No corrective
double moves; if the path looks wrong, fix the measured target, not the path.

## Read holds and the ending

Every landing earns its hold: the question sits alone before the reply, the
typed reply holds at full zoom before the pull-back, the reaction pops on a
settled frame. The story lands by ~85% of the runtime; the final lockup then
breathes almost invisibly (`scale: 1.014` over ~2.4s, `sine.inOut`) to the end.
A film that is still introducing ideas in its last second has no ending.

## Stage the opening outside the timeline

Zero-duration sets parked at position 0 are order-ambiguous under arbitrary
seeking. Stage the opening state with CSS (or one-time `gsap.set` calls made
during setup, before the paused timeline is registered); the timeline itself
only ever changes state mid-film. Micro-overshoot on arrivals (`back.out`
1.25–1.7 for UI, two-step 1.025 → 1.0 settle for emphasis) keeps motion alive
without jitter.
