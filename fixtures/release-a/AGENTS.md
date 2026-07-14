# Release A Hyperframes project

This project is the immutable owned fixture for Sequences.

- Read `.agents/skills/hyperframes/SKILL.md` first, use `general-video` for the build, then read only the relevant domain skills.
- Hyperframes HTML and assets are the only creative truth. Do not create a parallel timeline model.
- Preserve stable `data-hf-id` values.
- The exact runtime and skills are supplied by the Sequences host. Never run a network skill update or add a floating package.
- Use modular sub-compositions. Their `<style>`, markup, and `<script>` must all remain inside `<template>`; host, root, and timeline IDs must match.
- Run the host’s exact `hyperframes lint`, `check`, `keyframes`, and snapshot gates. Do not render or mutate accepted state from an author job.
