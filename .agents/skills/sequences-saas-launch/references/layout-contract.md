# Sequences SaaS layout and state contract

This is the first small deterministic layout primitive extracted from the legacy Slack direction. It is intentionally a fixed authoring contract, not a general layout engine.

## Frame and safe area

For a 1920 by 1080 film, keep critical readable UI inside `x=80..1840` and `y=64..1016`. Use a 12-column frame grid with 24 to 40px gaps. Main product surfaces normally occupy 60 to 88% of frame width and 55 to 82% of frame height; a tiny centered browser card is not a product shot.

Give every primary region a real zone before using absolute positioning:

- brand/status rail;
- product surface;
- action or cursor path;
- proof/CTA zone.

Decoratives may bleed outside the safe area. Readable copy, controls, code, and proof may not. Body copy and code must wrap or clip inside their own panels; do not rely on a full-frame `overflow: hidden` to hide bad placement.

Keep every readable subtree in the browser hit-test stack. Never apply `pointer-events: none` to a product surface, state layer, panel, or another ancestor of text: HyperFrames uses `elementsFromPoint()` to prove that text is not occluded, and a removed subtree will be reported as covered even when it is visibly painted. Use `pointer-events: none` only on text-free decoration such as glows, rules, particles, and cursors.

## Camera reserve

The camera viewport is a fixed, clipped box. The camera owner is one inner world wrapper. Critical content must fit at the largest camera scale and translation, not only at rest.

For end scale `s`, reserve at least the centered `1920/s` by `1080/s` region before translation. A 1.08 push therefore needs roughly 71px horizontal and 40px vertical overscan reserve even before adding the safe margin. Prefer scaling a padded inner world over scaling a 1920 by 1080 readable panel edge-to-edge.

The camera may move the world. Child elements may reveal or change state, but they must not also perform a competing camera transform.

## Persistent UI lifecycle

One semantic product surface stays mounted across causal beats whenever the story says it persists.

1. Build its readable resting state in CSS.
2. Give the surface one `fromTo()` entrance with an explicit hidden/offstage start and visible resting end.
3. Do not set `immediateRender: false` on that entrance. Under non-linear seek it exposes the resting CSS state before the cue, then invokes the entrance again.
4. After the surface is visible, use `to()` for emphasis, camera travel, color, or state changes. Do not use a second `from()`/`fromTo()` on the same visible element.
5. Put before/after content in child state layers. Crossfade those children while the surrounding product chrome stays stable.
6. Create the paused timeline with `defaults: { overwrite: "auto" }`. Do not overlap writes to the same property on the same target.

This is the failure pattern to avoid:

```js
tl.fromTo("#product-surface", { opacity: 0, y: 24 }, { opacity: 1, y: 0 }, 0.2);
// Bad: the already-visible surface is invoked again at the next beat.
tl.fromTo("#product-surface", { opacity: 1, y: 0 }, { opacity: 1, y: -12 }, 5.0);
```

Use:

```js
const tl = gsap.timeline({ paused: true, defaults: { overwrite: "auto" } });
tl.fromTo("#product-surface", { opacity: 0, y: 24 }, { opacity: 1, y: 0 }, 0.2);
tl.to("#product-surface", { y: -12, duration: 0.5, ease: "power2.inOut" }, 5.0);
```

## Contrast tokens

Choose text tokens against the actual composited panel colors before authoring dozens of descendants. Normal text and code must reach 4.5:1; large text must reach 3:1. Do not use opacity to create secondary text if the composited result drops below those ratios. Use a lighter or darker solid token instead.

Keep at most three readable text tiers per surface: primary, secondary, and muted. Reuse them. A different low-contrast gray for every code token creates many QA failures and weakens hierarchy.

## Mechanical preflight

Before returning the final artifact inventory, inspect source for:

- one entrance per persistent selector;
- no `immediateRender: false` on entrances;
- no overlapping writes to one target/property;
- readable content inside the safe area at rest and at the largest camera pose;
- no `pointer-events: none` on a readable container or state layer;
- `staysInFrame` targeting a critical readable subject rather than root/world/camera wrappers;
- one clear resting UI state at every proof time.
