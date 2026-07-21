# Showcase capsule: chatgpt-native-story

Tags: authentic conversation UI, streaming response, panel reflow, measured pointer, persistent product surface.

Use when the product story lives in a conversation with streaming, sources or side panels, document/canvas work, and several precise actions inside one coherent surface.

## Transferable lessons

- Keep question, coherent response, tool inspection, working document, refinement, and completion inside one persistent product surface.
- Reflow the conversation when a side panel opens instead of covering readable content; preserve the semantic owner while the layout changes.
- Resolve every pointer destination from the target's live root-local geometry at the exact click time, including active parent and camera transforms.
- Nest the ripple in its target control and hard-kill outgoing states at seams so arbitrary seeking cannot reveal duplicates.

## Known mistakes to avoid

- Do not turn real product features into oversized disconnected cards or a generic dashboard shell.
- Do not use a presentation-scale cursor, stage-global ripple coordinates, or approximate control centers.
- Do not treat streamed copy as texture; it must form a coherent useful answer.
- Do not let a newly opened panel occlude the conversation it explains.

## Inspect

- [Contact sheet](../assets/showcase-chatgpt-native-story-contact-sheet.jpg)
- [Composition](showcase-chatgpt-native-story-composition.html) — persistent UI states, streaming, reflow, measured pointer geometry, and lockup seam.
- [Component plan](showcase-chatgpt-native-story-component-plan.json) — stable state and part ownership across the story.

Adapt only the relevant technique; never reproduce the film wholesale.
