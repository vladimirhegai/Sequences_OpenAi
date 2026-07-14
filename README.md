# Sequences

Sequences is a localhost foundation for creating Hyperframes videos with Codex.
The product has a centered authoring conversation, the official Hyperframes
player for review, and the official Hyperframes Studio for the viewer, timeline,
inspector, and editing controls.

## Run locally

Prerequisites: Windows, Bun 1.3+, Node.js 22+, Git, FFmpeg, and an authenticated
Codex CLI.

```powershell
bun install --exact
bun run dev
```

Open the exact `http://127.0.0.1:4317/?boot=...` URL printed by the server. The
boot value is generated locally for each launch. Hyperframes Studio runs on
`127.0.0.1:5190` and is embedded by the app.

## Demo flow

1. Open **View immutable sample** to inspect the checked-in generic video.
2. Enter a video brief. Codex first returns a plan, then authors an isolated
   Hyperframes candidate after approval.
3. Review the candidate in the real Hyperframes player. Apply or reject it.
4. Open **Studio** to use Hyperframes' viewer, timeline, inspector, and editor.

The authoring backend invokes Codex CLI with `gpt-5.6-luna` and high reasoning.
Each candidate receives the pinned local Hyperframes skill bundle. Codex starts
at the Hyperframes router and reads only the relevant domain skills, which is the
project's local documentation-retrieval layer; it does not fetch floating docs
or update skills during a run.

## Foundation boundaries

- React owns the Sequences shell and conversation.
- Bun/Hono owns localhost jobs and the Codex CLI process.
- Hyperframes owns composition structure, playback, Studio, timeline, checks,
  snapshots, and rendering.
- Codex edits an isolated Git candidate. The host verifies and applies it; the
  model cannot promote its own work.
- `fixtures/release-a` is the immutable generic demo. `data/projects/release-a`
  is the accepted working project created by `bun run bootstrap`.

## Verify

```powershell
bun run doctor
bun run typecheck
bun run lint
bun run test
bun run qa:fixture
bun run render:fixture
```

The draft demo renders to `artifacts/release-a-draft.mp4`. Hyperframes and its
runtime packages are pinned to 0.7.56; the eight-skill authoring core and
142-item registry are also frozen locally for deterministic Codex runs.
