---
name: sequences-saas-launch
description: Direct and author fresh, fast-paced SaaS launch videos in the Sequences HyperFrames candidate. Use for product announcements, feature launches, AI/software demos, code-native UI stories, and brand films whose result must be a deterministic HyperFrames composition plus design, component, sequence, and motion evidence.
---

# Sequences SaaS Launch

Create a launch film, not a slideshow of marketing cards. Make the product or a credible code-native representation of it the recurring hero, with a clear story turn, intentional transitions, and motion that survives arbitrary seeking.

Read `references/layout-contract.md` before authoring so placement, camera reserve, and persistent UI lifecycle are fixed before motion is added.

Read `references/golden-principles.md` and `references/motion-contract.md` before authoring. Also read `hyperframes-creative/references/house-style.md`, `hyperframes-creative/references/video-composition.md`, and only the 2–4 animation rules that fit this brief. When the film needs a camera move, a typewriter, a pointer action, an energy peak, or a converging/docking gesture, read `references/golden-techniques.md` for the measured-geometry implementations that earned the quality bar. When the brief asks for an OpenAI-style launch film or names these moods — minimal type-led, kinetic typography, cosmic or starfield product theater, continuous-gradient device story, composer or voice-pill spot — read `references/openai-launch-grammar.md` for that grammar and its strict-gate survival checklist. When an OpenAI, ChatGPT, or Codex brand mark appears anywhere in the film, read `references/codex-mark.md` and copy its exact canonical knot path and rose-to-knot unfurl instead of redrawing the mark. The host already owns QA and rendering.

For product typing or pointer interactions, start from candidate-local `compositions/_primitives/typewriter.example.html` or `compositions/_primitives/pointer-action.example.html` and its adjacent JavaScript helper, then customize it; do not recreate either primitive from prose.

When `sequences-author-context-json.showcaseCapsules.selected` is present, inspect only those selected local capsule references and their contact sheets before composing. Open a listed source file only when its named technique fits the brief. Transfer the measured design or motion lesson; never duplicate an entire film, story arc, copy deck, or brand treatment, and do not load unselected Showcase capsules.

## Direct the film

1. Extract the promise, audience, evidence, product state, and desired tone from the brief. Do not invent unsupported customer metrics or integrations.
   Before composition implementation, choose one product-specific visual system in `story/design-capsule.json`, then express the same system in root `frame.md`. The host catalog is a starting vocabulary, not a forced aesthetic; use a reference-derived or bespoke capsule when the brief warrants it. Never inherit the Sequences web-shell `design.md` as generated-video taste.
2. If duration is unspecified, target 24 seconds. Treat 20–30 seconds as the normal SaaS launch range, but obey any explicit shorter or longer duration.
3. Design 4–6 causal beats. A useful arc is hook or friction → story turn → product action → product proof or scale → decisive CTA. Adapt it; do not force every brief into the same template.
4. Choose one visual world, one recurring hero entity, one energy peak, and a final resting image. Define 2–3 motion verbs and a coherent transition grammar.
   One visual world does not mean one fixed wide product shot. When duration permits, direct at least three visibly distinct framing states—an establish/friction frame, an operated close-up or focal push, and a resolved pullback/lockup—while preserving the hero's semantic identity.
   Map a crowded-to-quiet density arc. The energy peak must materially change silhouette, scale, density, or product state in sampled frames; a click, color change, or badge swap at unchanged framing is micro-motion, not the peak.
5. Write the semantic plan into `sequence.json` before finishing the implementation. Every adjacent beat boundary needs an explicit transition; `cut` is a deliberate and valid choice.
6. Direct the sound. Choose one soundtrack from the host `audioCatalog` by mood and energy arc and declare it in `sequence.json` `audio`, with SFX cues only where the film visibly causes them (typing window, pointer click, reveal pop, transition woosh, arriving notification). When the bed's beat analysis is confident, land beat boundaries and the energy peak near its bar grid. The host owns all audio files, levels, fades, and muxing; `audio: null` is a deliberate silent film, not a default.

## Author native HyperFrames

- Use composition timing attributes and one synchronous paused timeline per composition. All animation must be deterministic and seek-safe.
- Prefer bundled DOM, SVG, CSS, and GSAP-core techniques. Do not use registry items, network assets, shaders, Three.js, or premium GSAP plugins unless the candidate actually contains the required local runtime asset.
- Use only bundled or explicitly declared font-family names, followed by a generic family such as `monospace` or `sans-serif`. Do not paste OS font stacks such as `SFMono-Regular`, `Menlo`, or `Consolas`; undeclared named fallbacks are nondeterministic and fail HyperFrames lint.
- Show meaningful pixels at time 0. A quiet opening is valid; a blank frame is not.
- Build recognizable product UI, interaction, state, proof, and consequence. Avoid a sequence made only of centered headlines, generic metric cards, or disconnected browser mockups.
- Use video-scale hierarchy for the ideas a viewer must retain: primary launch copy normally 64–120px, explanatory copy 28–42px, and proof labels 18–24px. Smaller product microcopy may support texture, but it cannot carry the beat alone.
- Do not keep the full product surface at almost one scale and density for the entire film. Establish the world, isolate the decisive action, show its consequence, then simplify toward the ending.
- Author the implemented SaaS vocabulary in `story/component-plan.json`. Give each root a typed `data-component` archetype, stable `data-hf-id` parts, real root-scoped states, and beat/entity bindings. Reuse at least one persistent non-custom component across the product action and proof instead of rebuilding lookalike cards per scene.
- Use a single camera owner for a world. Keep child reveal/micro-motion transforms separate from the world transform.
- Build the final readable layout before animating it. Keep primary UI inside the Sequences safe area and reserve geometric headroom for the camera's largest pose.
- If a motivated product close-up intentionally crops non-critical surrounding chrome, clip it at one fixed viewport and place `data-layout-allow-overflow` only on the smallest moving inner camera layer. Never put it on the composition root, viewport, a persistent readable panel, or the focal target. Keep the focal target and primary copy fully inside the safe area at every landed pose; otherwise author a dedicated simplified close-up layer instead of scaling an edge-to-edge product world.
- A persistent UI element gets one entrance. After it is visible, mutate its state with `to()` or a child state layer; never replay its entrance with another `from()`/`fromTo()`. Do not put `immediateRender: false` on entrance tweens because it leaks the CSS-visible state before the cue and makes the same UI appear twice under seek.
- Create GSAP timelines with `defaults: { overwrite: "auto" }` and do not overlap writes to the same property unless a deliberate transform split makes the targets different.
- Scope every non-ID selector passed directly to a registered GSAP timeline with its `[data-composition-id="..."]` root. A unique `#id` is already safe. Never add overlap/occlusion suppression markers just because an element is decorative, `aria-hidden`, or a cursor; they require an exact declared overlap intent.
- Preserve readable hierarchy during entrances and handoffs. Never hide defects with broad layout suppression markers.
- Give the final lockup enough time to resolve—normally 1.2–4 seconds depending on the requested pace.
- Compose the final lockup as a new resting hierarchy: one brand/promise zone plus at most one dominant proof object. Subordinate or remove nonessential chrome instead of overlaying a logo on an unchanged dense product frame.

## Leave evidence

- `story/design-capsule.json` and root `frame.md`: one director-chosen visual thesis, exact palette/type/geometry bindings, composition dialect, motion verbs, and do/avoid rules. The machine and human forms must agree.
- `story/component-plan.json`: the typed code-native product components actually present in the composition, bound to the design capsule and semantic beats.
- `sequence.json`: format, exact beat timing and roles, semantic entities, transitions, optional camera intent, proof times, and implementation files. Every ID and entity part is a stable lowercase kebab-case identifier, never display copy; transition anchors belong to their adjacent beats, so repeat a recurring entity in each beat where it remains present.
- `index.motion.json`: full duration plus meaningful arrival/order, in-frame, and liveness assertions. Include at least one primary motion assertion per beat.
- Final response artifacts: plain project-relative POSIX paths only. Report a deleted file by its original path with no status annotation.

Before finishing, mechanically inspect the authored source for a nonblank first frame, full-duration coverage, composition-scoped timeline selectors, no broad or unjustified layout-suppression markers, one transition per boundary, camera ownership, and motion-sidecar selectors that exist. Do not run HyperFrames lint, check, snapshot, or render; the host does that independently.
