# Sequences

Sequences is a small local workspace for turning one generic prompt into a
HyperFrames video. It currently has four pieces:

- a generic prompt and dev-only prompt templates;
- a Sequences-owned, watch-only Studio with the real HyperFrames player and a
  simple timeline;
- a Bun server that runs Codex in a fresh HyperFrames scaffold, verifies it,
  and automatically promotes the result;
- a host-owned render job that freezes the promoted commit, verifies the MP4,
  and exposes MP4 and source-bundle downloads.

The project does not open or depend on HyperFrames Studio. The Sequences
timeline is a lightweight view of the HyperFrames composition; HyperFrames
HTML, assets, and its seekable runtime remain the creative source.

## Run locally

Prerequisites: Windows, Bun 1.3+, Node.js 22+, Git, FFmpeg, and an authenticated
Codex CLI.

```powershell
bun install
bun run dev
```

Open the exact `http://127.0.0.1:4317/?boot=...` URL printed by the server.

On native Windows, the local server defaults its Codex author subprocess to
`danger-full-access` because supported Codex CLI installations can silently
treat `workspace-write` as read-only. This compatibility mode is for the
loopback-only local app: Codex has unrestricted filesystem access during the
turn, while Sequences accepts only the allowlisted Git diff from its disposable
candidate worktree. Native Windows therefore always uses this compatibility
mode; a `workspace-write` environment override cannot restore the known
read-only failure. Non-Windows platforms continue to default to
`workspace-write` and may override it explicitly.

## Use it

1. Write a plain-language video prompt, or choose one of the three templates
   shown in development mode. Optionally attach up to four PNG, JPEG, or WebP
   product references; the host records their immutable dimensions and hashes.
2. Click **Generate**. Every run starts from the generic, contract-valid SaaS
   starter shell and a fresh direction; it does not edit or inherit the
   previous composition.
3. Wait while the configured author workflow runs and the host verifies the
   video. A passing result is automatically promoted and appears on the
   timeline.
4. Render the promoted commit, monitor or cancel the job, then download the
   verified MP4 and exact Git source bundle.

There is no plan-first workflow in the MVP. The prompt is intentionally generic
so the creative direction can stay with the person using the tool.

If a prompt does not name a duration, Luna targets 24 seconds. The normal range
for a SaaS launch film is 20–30 seconds, but an explicit shorter or longer
duration always wins.

In the default balanced route, every click on **Generate** creates fresh
preproduction, compositor, and audit custody. A bounded repair resumes the exact
Terra compositor thread while the same run is being verified; it never
continues a previous generation. Candidate worktrees are internal quarantine,
not a public review or Apply/Reject workflow.

## Balanced agent workflow

Balanced is the production default and targets a useful website result in
roughly ten minutes on a healthy model route. That is a latency target, not a
hard SLA: strict QA or a focused repair can extend a difficult run.

Balanced mode is a sequential specialist pipeline, not a voting committee:

1. One Sol/medium preproduction turn locks the per-film `frame.md`, design
   capsule, causal `sequence.json`, component plan, camera intent, and sound
   direction.
2. Terra/medium is the sole owner of renderable source, UI placement, camera, and
   motion. Contract, layout, QA, and audit repairs resume this exact thread and
   route.
3. After strict deterministic QA passes, Sol/medium receives rendered temporal
   evidence labeled as transit or landed and emits a read-only typed audit. At
   most one localized compositor polish is accepted, and only after the full
   contracts and strict QA pass again.

The author context stays bounded: prompt plus locked `sequence.json` selects at
most two hash-pinned Showcase capsules, and the receipt records their IDs. The
compositor treats them as transferable craft references, never as films to
copy. Product typing and click briefs also point directly at the local
`compositions/_primitives/` helpers copied into every fresh candidate. Typing
and mouse-click audio cues reserve their own start/mid/end and
approach/contact/consequence audit frames before generic temporal coverage.

Stage write scopes are disjoint and creative/component handoffs are hash-locked.
The run receipt records every turn's role, operation, model, effort, thread,
latency, token usage, and cached-input usage. Override individual experimental
routes with `SEQUENCES_CREATIVE_*`, `SEQUENCES_COMPONENT_*`,
`SEQUENCES_COMPOSITOR_*`, and `SEQUENCES_AUDITOR_*`; see `.env.example`.

The stages intentionally run sequentially because every later stage consumes a
hash-locked handoff. The former standalone Sol component pass was folded into
preproduction to remove one full model round trip. Transient capacity and
transport failures receive two short retries on the exact thread. For a
controlled legacy comparison, set `SEQUENCES_AGENT_WORKFLOW=legacy` before
starting the server.

## Test without opening the website

```powershell
bun run test:project
```

This checks the Codex and HyperFrames CLIs, starts the server in memory with
temporary project directories, exercises the local session/bootstrap API, and
loads the signed sample composition route. It does not open a browser or start
the dev server.

Useful verification commands:

```powershell
bun run doctor
bun run typecheck
bun run test
bun run build
bun run qa:fixture
bun run test:phase -- 0
bun run test:phase -- 1
bun run test:all
```

The offline phase/unit suites use a deterministic fixture author; they verify
orchestration and contracts but do not prove that Luna can write a real website
candidate. For a literal website-parity probe, start the site and drive its real
Prompt form and Generate button through a browser:

```powershell
bun run probe:website -- --image <file1> --image <file2> "your exact prompt"
```

This command loads the current boot URL, establishes the normal browser
session, uploads through the website control, clicks Generate, and waits until
the generated composition is applied and ready in the timeline. The separate
opt-in pipeline acceptance gate owns a production-default server, promotes the
verified candidate, performs a draft render, and checks the persisted MP4 and
source bundle:

Use `bun run probe:website -- --check-ui` for a no-submit browser smoke test of
the Prompt and Generate controls.

```powershell
bun run test:live-website -- --image <file1> --image <file2> "your exact prompt"
```

`bun run render:fixture` is available for an explicit local draft render.
`test:phase -- 0` is the Phase 0 exit gate: it wraps doctor, typecheck, build,
unit and browserless tests, fixture verification and automatic promotion,
pinned HyperFrames QA, a draft render, `ffprobe`, boundary-frame decoding, and
both download routes. Evidence and a durable receipt are written under
`artifacts/tests/phase-0/latest/`.
`test:phase -- 1` verifies fresh-run custody, the versioned `sequence.json`
contract, the director-owned `frame.md`/design capsule, typed reusable SaaS
components, semantic transitions and camera intent, the required motion sidecar,
server-owned automatic promotion, and the watch-only Studio build. It also
exercises overlap-intent validation, handoff clustering, renderer-backed
inspection, broad-suppression rejection, bounded same-run repair, and rollback.
Its receipt is written under `artifacts/tests/phase-1/latest/`.

## Codex and HyperFrames skills

The host supplies the six-skill `sequences-saas-launch-local-v1` profile:
`hyperframes`, `hyperframes-core`, `hyperframes-creative`,
`hyperframes-animation`, `hyperframes-keyframes`, and
`sequences-saas-launch`. It verifies the profile manifest plus every copied
skill hash. Luna receives a compact catalog and reads only the relevant copied
skill references. The launch skill contains five compact Showcase capsules
(contact sheet plus a few focused source references each), while the SaaS shell
contains offline typewriter and pointer-action primitives with copyable
examples. Author jobs cannot update skills, acquire workflows, install
registry items, or assume a runtime that the host did not supply.

The Codex output and compact `sequence.json` contracts are validated before a
generated video is promoted. The semantic artifact records exact beat timing,
transition ownership, and camera intent when a beat uses a camera;
`index.motion.json` records executable motion assertions. The host owns
the authoritative authored-file inventory from the candidate Git diff,
HyperFrames lint/check, bounded category-level QA remediation, Git promotion,
and rendering. Luna's handwritten artifact list is receipt context, not a
security boundary.
The contrast fixer uses measured samples, WCAG luminance, and perceptual OKLab
search; it is accepted only if the failing category strictly improves and the
complete strict check still passes.

Layout QA stays semantic rather than becoming a universal CSS fixer. Repeated
overlap/occlusion findings are collapsed into root-cause clusters, broad ignore
markers are rejected, and exact overlap intent is checked against renderer-backed
readability evidence. An unresolved cluster may give the same run's Luna thread
an annotated frame/crop plus `inspect_layout` geometry in its quarantined
worktree. Related actionable clusters from the same implementation composition
are repaired as one class. At most three file-scoped layout-repair turns are
allowed, and each is adopted only after strict QA and unchanged proof frames are
rerun.

## Scope

This is the foundation, not the final Sequences product. It deliberately leaves
out evidence graphs, arbitrary URL capture, multi-project management, a large
inspector, custom rendering, and a full NLE timeline.

`ARCHITECTURE.md` is the single architecture reference (pipeline stages and
failure owners, the HyperFrames boundary, the phase roadmap, and the testing
contract). The running code and the HyperFrames composition contract are
authoritative for current behavior.
