# Sequences agent guide

## Product

Sequences is a motion-design AI for SaaS launch videos, built natively on HyperFrames. A user writes one prompt and clicks Generate; a fresh Luna (Codex) director authors an isolated HyperFrames candidate from the SaaS starter shell; the host verifies it with the pinned HyperFrames gate, repairs narrowly and transactionally, promotes a passing result automatically, and shows it in the watch-only Sequences Studio; a human-triggered render exposes the verified MP4 and source bundle.

HyperFrames owns composition, playback, editing primitives, QA, and rendering. Sequences owns creative direction, semantic result contracts, verification custody, evidence, and delivery — not a rebuilt video platform. The primary product is one prompt → generate → excellent video; editing and revision flows are later phases.

The current user request defines the task scope. Running code and the pinned HyperFrames contract are authoritative for current behavior.

## Documents

- [`README.md`](README.md): setup, product loop, commands.
- [`ARCHITECTURE.md`](ARCHITECTURE.md): the single architecture reference — pipeline stages and failure owners, HyperFrames boundary and sharp edges, phase roadmap, planned motion toolkit, Slack Sequences mining guide, testing contract. The former `HYPERFRAMES.md`, `REPORT_SLACK_SEQUENCES.md`, and `OPENAI_HACKATHON_PLAN.md` were absorbed into it and deleted.
- [`HACKATHON_RULES.md`](HACKATHON_RULES.md): submission requirements and judging constraints.
- [`design.md`](design.md): the product web-UI design system (colors, type, layout for the Sequences app shell itself).
- [`fixtures/release-a/AGENTS.md`](fixtures/release-a/AGENTS.md): extra rules for fixture authoring.

Do not read every document for every task; follow links only when the work needs them.

## Execution and scope

1. Identify the concrete requested result and the smallest files that own it.
2. Implement that result before investigating adjacent improvements.
3. Run the smallest relevant verification.
4. Review the diff for scope before reviewing it for elegance.
5. Stop when the requested result is verified and no in-scope blocker remains.

Rules:

- Do not reinterpret a feature, fix, or document edit as a system-hardening or architecture project.
- Do not redesign settled behavior, broaden guarantees, add generalized infrastructure, or fix adjacent concerns without approval.
- For diagnosis/review tasks, report findings; do not implement fixes unless asked.
- Record unrelated ideas under **Optional follow-ups** instead of implementing them.
- Prefer one class-level fix and one regression test over an expanding chain of edge-case handlers. Reproduce failures offline before paid/live probes whenever a deterministic reproduction is possible.
- Disk truth beats model claims: completion, artifact inventories, and promotion decisions come from the filesystem and Git diff, never from a model's self-report.
- The host verifies; it does not co-direct. Objective invalidity may be repaired deterministically; creative weakness goes back to the director with evidence.

## Debugging a failed generation

Every run leaves a diagnosis packet under `data/runs/release-a/<run_id>/`. Start at `receipt.json`: `state` + `error.code` + `error.owner` name the owning stage. Then open that stage's evidence — `codex.jsonl`/`stderr.log` for authoring, `qa/attempt-N/` for HyperFrames verification, `layout-repair/attempt-N/` and `turns/` for bounded repair, `changes.patch` for promotion. Fix the owning stage surgically; never rewrite the pipeline in response to one run. The stage table lives in `ARCHITECTURE.md` → "The generation pipeline and its failure owners."

## Model routing

- `SEQUENCES_AGENT_WORKFLOW=balanced` is the production default: Sol/medium
  locks design, story, and the component plan in one preproduction turn;
  Terra/medium owns render source; Sol/medium performs the read-only temporal
  audit. Every creative repair resumes the exact compositor thread and route.
- `SEQUENCES_AGENT_WORKFLOW=legacy` remains available for controlled
  comparisons. Its director is set per launch by `SEQUENCES_CODEX_MODEL`
  (default `gpt-5.6-luna`) and `SEQUENCES_CODEX_EFFORT` (default `high`).
- Balanced stages are sequential until cancellation custody can own multiple
  Codex subprocesses for one job. The visual auditor is read-only, cannot
  suppress deterministic QA, and may request at most one compositor polish
  followed by the complete contract and strict-QA gates.
- Author context deterministically selects at most two hash-pinned Showcase
  capsules from the prompt plus `sequence.json`; receipts record their IDs.
  Treat them as bounded inspiration, never as source films to duplicate.
- Receipts record every actual turn's role, operation, route, thread, duration,
  and token/cache usage. Sol/Terra roles earn promotion only through repeated
  same-prompt evidence.
- High reasoning is permission to solve difficult in-scope work, not permission to widen the goal. Once the cause, requested change, and focused test are known, stop searching for additional problems.

## Repository map

```text
.
├─ apps/web/                         Sequences web product
│  ├─ src/client/                    React prompt + watch-only Studio UI
│  │  ├─ App.tsx                     Workspace, run progress, failure surfaces
│  │  ├─ SequencesStudio.tsx         Player + scene strip + scrubbing (watch-only)
│  │  ├─ HyperframesViewer.tsx       Player web-component bridge
│  │  └─ api.ts                      Typed client calls
│  ├─ src/server/                    Bun/Hono host and trusted orchestration
│  │  ├─ app.ts                      Routes and runtime wiring
│  │  ├─ job-manager.ts              Run lifecycle: author → verify → repair → promote
│  │  ├─ codex-runner.ts             Bounded Codex process, prompt, completion detection
│  │  ├─ hyperframes.ts              Pinned lint/strict-check verification
│  │  ├─ layout-clusters.ts / layout-inspector.ts / overlap-policy.ts
│  │  │                              Typed layout clustering + renderer-backed adjudication
│  │  ├─ qa-fixers/                  Category-owned deterministic repairs (contrast)
│  │  ├─ project-store.ts            Git custody, fresh candidates, SaaS starter shell install
│  │  ├─ render-manager.ts           Host-owned render jobs and verification
│  │  ├─ run-store.ts                Receipts and event ledger
│  │  ├─ sequence-artifact.ts        sequence.json / index.motion.json contracts
│  │  └─ skills.ts / skill-catalog.ts  Hash-pinned author profile custody
│  ├─ src/shared/                    Zod contracts shared by client/server
│  └─ test/                          Unit/contract tests (vitest)
├─ fixtures/release-a/               Owned HyperFrames sample/golden fixture
├─ fixtures/saas-shell/              Contract-valid SaaS starter shell for fresh builds
├─ scripts/                          bootstrap, doctor, pinned HF wrapper, smoke, phase tests, generate
├─ .agents/                          Hash-pinned author skills and registry snapshot
├─ vendor/hyperframes/               Reference HyperFrames source; do not edit casually
├─ data/                             Managed local project/run state; not source code
└─ artifacts/                        Generated renders and test evidence
```

Generated/dependency directories (`apps/web/dist/`, `node_modules/`, `data/`, `artifacts/`) are not hand-edited.

The SaaS starter shell (`fixtures/saas-shell/`) is copied into every fresh candidate. It includes candidate-local typewriter and pointer-action helpers under `compositions/_primitives/`; capability context points at those files for matching briefs. The shell must stay contract-valid and finding-free under the pinned strict check on its own; if you change it, rerun its offline gate (assemble with fixture technical files + assets, then pinned `lint` and `check --strict`). It deliberately ships no `index.motion.json` — that file's presence is the disk-truth completion signal for authoring.

## Verification

Choose the narrowest useful checks:

- Markdown only: `bun x oxfmt --check <changed.md>`
- TypeScript: `bun run typecheck` and the relevant vitest file, or `bun run test`
- Client/build changes: `bun run build`
- Environment/foundation: `bun run doctor` and `bun run test:project`
- HyperFrames fixture: `bun run qa:fixture`
- Phase gates: `bun run test:phase -- 0`, `bun run test:phase -- 1`; `bun run test:all` at exit gates only
- Judge path: `bun run judge`
- Live website probe (requires running server): `bun run probe:website -- "<prompt>"`. This drives the real browser UI, fills the Prompt control, and clicks Generate; use it when claiming website parity. `bun run generate -- "<prompt>"` remains an API/pipeline probe and is not a substitute for UI parity.

Render only when the task requires an output video.

## When to update this file

Update `AGENTS.md` when a durable repo-wide convention changes: product boundary, document routing, folder ownership, canonical commands, model routing, verification expectations, or scope/approval rules. Do not update it for one feature's design, temporary phase status, or one-off workarounds — put those in `ARCHITECTURE.md` or the owning code. Keep this file short; changes are picked up by new Codex runs/sessions.
