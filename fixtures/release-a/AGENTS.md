# Minimal HyperFrames project

This project is the generic owned fixture for Sequences.

- Read `.agents/skills/hyperframes/SKILL.md` first, then use the repo-specific `sequences-saas-launch` workflow for a fresh SaaS build and only the relevant domain skills selected by the host.
- Read `hyperframes-core` before editing composition HTML. Use `hyperframes-animation`, `hyperframes-keyframes`, or `hyperframes-creative` only when the request needs them.
- HyperFrames HTML and assets are the creative source. The Sequences studio timeline is a lightweight view of that source, not a second renderer.
- Preserve stable `data-hf-id` values.
- The exact runtime and skills are supplied by the Sequences host. Never run a network skill update or add a floating package.
- Use modular sub-compositions. Their `<style>`, markup, and `<script>` must all remain inside `<template>`; host, root, and timeline IDs must match.
- The Sequences host owns the exact pinned `hyperframes lint` and `check` gates. An author job must not run those commands, preview, open Studio, render, or mutate accepted state; repository maintainers can run `bun run qa:fixture` outside an author job.
