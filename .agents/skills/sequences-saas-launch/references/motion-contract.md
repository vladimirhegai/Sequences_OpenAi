# Sequences motion contract

## Beat timing

Use absolute seconds in `sequence.json`. Beats may overlap for a declared handoff, but their starts must follow story order and the final beat end must equal `format.targetDuration`. Put proof samples inside the beat they prove.

Build each beat as three phases when useful:

1. Build: introduce or transform the focal subject.
2. Breathe: hold long enough for the idea or UI state to read.
3. Resolve: settle, hand off identity, or cut with intent.

Avoid starting every element at a beat boundary. Use internal rhythm, while keeping copy readable before the next idea competes for attention.

## Camera intent

A camera is a semantic owner, not a pile of unrelated scale tweens. When a beat uses one, record:

- `owner`: `dom-world` for a single DOM/SVG world wrapper, or `three-world` only when the local runtime is truly supplied;
- `targetEntityId`;
- fixed start and end poses using `x`, `y`, `z`, `scale`, `rotationX`, `rotationY`, and `rotationZ` (`rotationZ` is the 2D DOM roll);
- exact absolute `arrival`, `settle`, and `hold` fields.

One world wrapper owns pan/zoom/rotation. Children own entrances, highlights, counters, cursor actions, and local morphs. Never animate the same transform property concurrently on parent logic and a second camera helper.

Reserve camera headroom in the static geometry. A camera wrapper that reaches scale `s` may only contain critical readable content inside the centered `(width / s) by (height / s)` region at that pose. Keep a clipped viewport outside the camera owner, and assert `staysInFrame` on the readable product surface or control that must remain visible, never on a full-canvas world wrapper that intentionally overscans.

## Semantic identity

Every `id` and every `entities[].parts` entry is a stable lowercase kebab-case identifier such as `approval-control`, never a display label such as `Approve button`. Put descriptive language in `role` or `purpose`.

Transition anchors are local to their boundary: the outgoing entity must be declared in `fromBeatId`, and the incoming entity must be declared in `toBeatId`. When one product surface persists across several beats, repeat its stable entity ID in each beat where it is still present. This makes match cuts, morphs, future selection, and layout evidence deterministic.

## Boundary vocabulary

- `cut`: instantaneous editorial handoff; use when a visual reset improves comprehension.
- `match-cut`: preserve a semantic object, silhouette, color field, or screen region across shots.
- `morph`: transform one declared outgoing entity into one declared incoming entity; both anchors must exist.
- `pan`: one world or aligned pair travels through the boundary.
- `zoom-cut`: camera travel motivates a cut at the energy peak.
- `dissolve` or `wipe`: use sparingly and only when it serves the product story.

Every boundary has one mechanical owner. Do not stack a global transition, scene exit, child exit, and camera move on the same pixels without a deliberate transform split.

For persistent SaaS state handoffs, preserve a readable continuity anchor through every frame. Do not symmetrically fade two complete state layers toward zero and leave the content zone visually empty. Prefer either:

- a deterministic match cut (`set` outgoing hidden and incoming visible at the same timestamp), followed by local highlight motion; or
- a true overlap where the incoming state is already materially visible before the outgoing state drops below readable opacity.

At the transition midpoint, at least one primary state must remain clearly readable. The stable product shell alone is not sufficient continuity when its content zone is empty.

Complete DOM UI states that each contain readable text must never crossfade or coexist. Swap their `display` / `visibility` / `autoAlpha` atomically with one GSAP `set` at the boundary, then animate the persistent shell, one genuinely shared entity, or non-reading-order accents. A morph is not permission to stack duplicate headings, badges, rows, or metrics during the handoff.

## Motion evidence

Create `index.motion.json` for the rendered entry composition. Use selectors that are stable and unique across subcompositions. Assertions should cover:

- a primary subject appearing by its intended landing;
- narrative order for at least the important subject/action pair;
- important UI/camera subjects staying in frame;
- liveness in motion-heavy worlds without forcing constant motion during deliberate holds.

`staysInFrame` observes the selected element's full box for the whole composition. Target a critical readable subject that is actually meant to stay inside the canvas; do not target an oversized camera/world wrapper or an element that intentionally exits. `keepsMoving` also observes the whole composition. Use it only for a selector that remains present and meaningfully active for that spanâ€”never for a product scene that hands off to a deliberately static CTA. A final hold is allowed, and `keepsMoving` is optional.

Do not use a trivial root-only assertion as the whole sidecar. The sidecar is evidence of authored intent, not a checkbox.

Use HyperFrames' exact schema; do not invent per-tween evidence fields:

```json
{
  "version": 1,
  "duration": 24,
  "assertions": [
    { "kind": "appearsBy", "selector": "#hero", "bySec": 1.2 },
    { "kind": "before", "a": "#hero", "b": "#cta" },
    { "kind": "staysInFrame", "selector": "#product-surface" },
    { "kind": "keepsMoving", "withinSelector": "#product-world", "maxStaticSec": 2 }
  ]
}
```

The supported assertion kinds are only `appearsBy`, `before`, `staysInFrame`, and `keepsMoving`.

## Layout discipline

Use fixed composition geometry and authored coordinates. Follow `layout-contract.md` for safe areas, camera reserve, and UI zones. Sample entrance, settle, handoff, and final-hold states mentally while authoring. Structural roots should not carry aggregate readable text or broad overlap exemptions; semantic children own identity and any narrow declared overlap.
