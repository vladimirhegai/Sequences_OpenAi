---
name: sequences
kind: web-interface
version: 1
scope: repository-shell-only
description: "A HyperFrames-native creative director and motion-design workspace for turning source material into coherent, reviewable video."
characteristics:
  - "Source-faithful"
  - "Editorial and motion-led"
  - "Candidate-based and reversible"
  - "Inspectable and evidence-backed"
  - "HyperFrames-native"
colors:
  canvas: "#F4F0E8"
  surface: "#FCFAF5"
  surface_subtle: "#EEE9E1"
  surface_strong: "#E4DED4"
  ink: "#202124"
  graphite: "#17191C"
  muted: "#6C6A66"
  quiet: "#746F68"
  border: "#D8D1C7"
  border_strong: "#B8AFA3"
  cobalt: "#2457D6"
  cobalt_hover: "#173EA9"
  cobalt_soft: "#E8EEFF"
  amber: "#9A5900"
  amber_soft: "#FFF1D6"
  red: "#B42318"
  red_soft: "#FDE8E7"
  green: "#18794E"
  green_soft: "#E1F2E8"
typography:
  display: "Space Grotesk, Inter, system-ui, sans-serif"
  ui: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
  mono: "IBM Plex Mono, SFMono-Regular, Consolas, monospace"
spacing:
  base: 4
  scale: [4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80]
radii:
  control: 4
  card: 8
  composer: 12
  dialog: 12
geometry:
  top_bar_height: 56
  create_chat_width: 720
  studio_header_height: 40
  studio_left_default_width: 240
  studio_right_default_width: 400
  studio_timeline_default_height: 340
  studio_timeline_min_height: 100
  studio_preview_min_height: 120
constraints:
  - "The centered chat owns Create mode."
  - "The complete official Hyperframes Studio owns Edit mode."
  - "Never implement a second timeline, renderer, player runtime, inspector, or keyframe model."
  - "Never apply these shell tokens to generated video compositions without their frame.md opting in."
---

# Sequences Design Specification

## Product experience thesis

Sequences is a HyperFrames-native creative director and motion-design workspace.

It turns a brief and source material into a coherent, source-faithful video, then makes each AI-authored change inspectable, testable, reversible, and attributable.

> Scope: this specification governs the Sequences web shell. Each generated HyperFrames video project owns its own `frame.md`; never apply the shell palette or layout to a composition unless that project's frame specification explicitly chooses it.

The experience is intentionally split into two modes:

- Create: a centered Codex conversation for evidence, planning, and authoring.
- Edit and review: the real Hyperframes viewer and Studio timeline, surrounded by lightweight Sequences context.

The shell must make the sequence obvious:

Plan → Build → Verify → Review

Sequences owns project context, evidence, Codex jobs, candidate isolation, QA aggregation, comparison, approval, and receipts. Hyperframes owns composition HTML, assets, playback, timeline editing, selection, undo/redo, keyframes, and rendering.

### Principles

1. Evidence before generation. Uploaded screenshots, URLs, and facts become reviewable sources before they become claims.
2. Plan before Build. The user approves the storyboard and visual direction before scene files are authored.
3. Every AI mutation is a candidate. No model job silently changes accepted state.
4. Real editor, real playback, real timeline. The official Hyperframes Studio and player are the product surface.
5. Long-running work is honest. Progress reflects observed Codex and Hyperframes events, not fabricated percentages.
6. Review is a first-class product step. Diffs, QA findings, affected scenes, proof frames, and receipts are visible before Apply.
7. Preserve identity. Components and evidence remain linked through stable Hyperframes `data-hf-id` identities.
8. Editorial restraint. Warm neutral surfaces, graphite structure, cobalt action color, thin rules, and purposeful density.
9. Reveal complexity progressively. Do not expose future capabilities as disabled or decorative controls.
10. Failure remains visible. The immutable sample is never presented as the result of a failed live run.

## Information architecture

### Routes and modes

| Route | Mode | Primary purpose |
|---|---|---|
| `/projects/:id/create` | Create | Add evidence, approve claims, choose a preset, chat with Codex |
| `/projects/:id/editor` | Edit | Inspect and edit the accepted Hyperframes composition |
| `/projects/:id/review/:candidateId` | Review | Compare accepted and candidate versions, inspect QA, Apply or Reject |
| `/projects/:id/receipts/:runId` | Receipt | Inspect the immutable record of a Plan, Build, Revision, Apply, Revert, or Export |
| `/sample` | Immutable sample | View the prepared golden sequence and its evidence without requiring credentials |

### Global shell

The Sequences shell provides:

- project identity;
- workflow stepper;
- current accepted commit;
- job state;
- sample/offline indicator;
- access to review and receipts;
- final export entry point.

The shell does not provide:

- a second timeline;
- a second renderer;
- a second composition player;
- a duplicate Hyperframes inspector;
- a fake layer or keyframe model.

### Workspace ownership

The same visual slot changes owner by mode so the interface never crowds the editor.

| Slot | Create mode | Edit mode | Review mode |
|---|---|---|---|
| Left slot | Hidden | Official Hyperframes Studio sidebar; Sources stay in the outer Sequences shell | Sources and claims |
| Center | Centered Codex chat | Hyperframes Studio viewer and timeline | Active/candidate Hyperframes players |
| Right slot | Hidden | Official Studio inspector; Sequences context may be an outer sibling only after the embedding contract passes | Candidate summary, QA, diff, receipt |
| Bottom | None | Official Hyperframes timeline | Optional compact time scrubber from Hyperframes player |

This table describes user-visible ownership, not an assumed Studio extension API. The foundation must not inject Sequences panels into undocumented Studio internals. If same-origin `StudioApp` embedding passes its contract tests, an outer Sequences drawer may resize the whole Studio surface as a sibling. Otherwise, context remains in the Sequences route and `/editor` opens the official full Studio intact.

## Primary user flow

1. Open an empty project or the immutable sample.
2. Add a public URL, screenshots, and release facts.
3. Review extracted evidence and assign rights status.
4. Approve supported claims; explicitly exclude unsupported claims.
5. Choose a versioned preset such as Feature Release.
6. Start Plan from the centered Codex chat.
7. Review the storyboard, scene roles, claims, evidence links, duration, and motion constraints.
8. Approve Plan.
9. Start Build from the same conversation.
10. Observe real Codex authoring and independent Hyperframes verification.
11. Enter Review when the candidate is ready.
12. Compare accepted and candidate players, semantic changes, source diff, QA findings, and proof frames.
13. Apply or Reject the candidate.
14. Open the accepted composition in the real Hyperframes Studio.
15. Select a component in the viewer or timeline.
16. Request a scoped Revision using the contextual Codex composer.
17. Verify the new candidate and Apply, Reject, or Revert.
18. Export the accepted composition and inspect the receipt.

A user should understand the workflow from the first screen without reading documentation.

## Layout geometry

All dimensions below are CSS pixels. The honest editing target is a 1440 × 900 desktop viewport.

### Global top bar

The Sequences top bar is 56px high.

- Background: `#FCFAF5`
- Bottom border: `1px solid #D8D1C7`
- Horizontal padding: 24px
- Left cluster: 248px maximum
- Center workflow stepper: centered in the viewport, not merely between left and right clusters
- Right cluster: 280px maximum
- Content baseline: 32px
- Primary controls: 32px high

The top bar contains:

Left:

- Sequences wordmark;
- project name;
- accepted commit short hash.

Center:

- `Plan`
- `Build`
- `Verify`
- `Review`

Right:

- current job state;
- `Open receipt`;
- `Export` when an accepted composition exists.

The stepper is not a decorative progress bar. Only completed or currently available steps are interactive.

### Empty/create state

At 1440 × 900:

- top bar: 56px;
- create canvas: remaining 844px;
- no persistent side rails;
- chat column: exactly 720px wide;
- chat column is horizontally centered against the full viewport, not the space between hidden panels;
- top offset from create canvas: 112px;
- composer bottom edge: no closer than 96px to the viewport bottom.

Structure:

```text
56px  global Sequences top bar
844px create canvas
      112px top breathing space
      720px centered chat column
      flexible transcript
      96px bottom breathing space
```

The centered column contains:

- 40px mode eyebrow: `CREATE SEQUENCE`;
- 48px title: `Turn product evidence into a sequence`;
- 24px supporting copy;
- transcript region with a maximum height of 340px;
- attachment tray;
- composer;
- small Plan/Build action row.

The first screen must look like a focused editorial desk, not a three-column dashboard.

### Editor state

At 1440 × 900:

- Sequences top bar: 56px;
- official Hyperframes Studio header: 40px;
- Studio body: 804px;
- official default timeline height: 340px;
- preview/editor top row: 461px;
- horizontal timeline resize seam: 3px visible, 8px pointer target;
- Studio left sidebar: 240px;
- Studio right inspector: 400px when explicitly opened;
- panel seams: 3px visible, 8px pointer target;
- minimum preview top-row height: 120px;
- minimum timeline height: 100px.

Default editor geometry with no external Sequences drawer:

```text
56px  Sequences top bar
40px  official Hyperframes StudioHeader
461px Studio top row
3px   timeline resize seam
340px official Hyperframes timeline
```

With the official Studio inspector open:

```text
240px left Studio sidebar
3px   resize seam
flex  Hyperframes preview
3px   resize seam
400px right Studio inspector
```

The preview width at 1440px is approximately 794px when both Studio side panels are open.

With no selection, the right Studio inspector remains collapsed so the viewer gets maximum width.

When a selection is made, Sequences receives its stable context through the supported selection contract. If the embedding spike is green, a 320px outer Context drawer may resize the complete Studio surface; it does not replace `StudioRightPanel`. The official inspector stays inside Studio. In the full-Studio fallback, `Back to Sequences` returns to the contextual Revision surface without losing the selected `hfId`, source file, scene, or time.

### Review state

At 1440 × 900:

- top bar: 56px;
- review workspace: 844px;
- main review grid: 2 columns, `minmax(0, 1fr) 360px`;
- player comparison area: flexible width;
- context/QA panel: 360px;
- player gap: 16px;
- player aspect ratio: 16:9;
- player controls: 40px;
- source/diff/QA sections scroll independently within the 360px panel.

For a 1440px viewport, the two 16:9 players should be approximately 500–520px wide each, depending on the review panel width.

### Drawer geometry

Sequences drawers use:

- default width: 320px;
- minimum width: 280px;
- maximum width: 420px;
- background: `#FCFAF5`;
- border: `1px solid #D8D1C7`;
- no floating shadow when replacing a Studio slot;
- 12px inner padding;
- 16px section spacing.

An embedded drawer occupies a sibling slot outside the complete Studio surface, causing the Studio viewport to resize as one unit. It never injects into Studio, covers the timeline, or depends on a private panel hook. If that contract is not stable, use the separate Sequences context route instead.

## Centered chat behavior

### Create mode

The Codex conversation is the visual and functional center of the empty state.

It is not a generic chatbot:

- messages are editorial transcript rows, not floating speech bubbles;
- the user prompt is displayed as a compact ruled block;
- Codex responses are structured into evidence, plan, decision, and progress sections;
- assistant messages may contain a storyboard strip, claim references, or a job timeline;
- actions are attached to the relevant message, not duplicated in a global toolbar.

The first composer placeholder is:

`Describe the release story you want to make…`

The composer supports:

- natural-language brief;
- pasted facts;
- screenshot attachment;
- URL attachment;
- before/after pairing;
- Plan action.

### Plan approval

After Plan completes, the chat remains centered. The conversation displays:

- scene list;
- scene purpose;
- approved claims;
- supporting evidence;
- duration;
- selected Hyperframes preset;
- motion constraints;
- known omissions.

The primary action changes from `Plan` to `Approve plan and Build`.

Build does not begin automatically.

### Authoring mode

During Build, the chat remains centered and becomes a live job desk.

The view shows:

- current stage;
- elapsed time;
- last observed activity;
- current file or artifact;
- completed stages;
- cancellation;
- failure details when applicable.

If a stage has no reliable numeric completion value, show an indeterminate activity line rather than inventing a percentage.

### After generation

When the candidate reaches review-ready:

1. the centered chat view transitions to `/review/:candidateId`;
2. the accepted and candidate Hyperframes players become the center;
3. the same conversation history is preserved;
4. the composer moves into the right Context drawer under `Revision`;
5. the selected element, scene, source file, time interval, and base commit are automatically attached to a revision request.

The chat does not remain as a floating bubble over the viewer.

The right drawer header reads:

`Revision context`

It includes:

- candidate or accepted status;
- selected `hfId`;
- scene and source file;
- playhead time;
- linked evidence and claims;
- revision composer.

A `Return to Create` action re-enters the centered chat mode without losing the conversation.

## Hyperframes integration boundary

### System of record

Hyperframes owns:

- HTML compositions;
- assets and local media;
- `data-hf-id` identities;
- composition metadata;
- playback runtime;
- timeline tracks and clips;
- keyframes and easing;
- selection;
- inspector;
- undo/redo;
- lint, check, snapshots, keyframe inspection;
- draft and final rendering.

Sequences owns:

- project identity;
- evidence and claim graph;
- preset locks;
- Codex job orchestration;
- candidate branches and base commits;
- allowed-path policy;
- QA aggregation;
- review decisions;
- Apply, Reject, Revert;
- receipts;
- stale dependency propagation.

### Real Studio boundary

The preferred integration is:

- official Hyperframes Studio served on a same-origin `/editor` route;
- official Studio API mounted at the root-relative `/api` path it expects;
- Sequences project state and review panels provided as sibling shell slots;
- selection context read through the documented selection API or CLI context contract;
- candidate promotion followed by an explicit Studio reload when hot reload is not guaranteed.

The Studio remains visually dark and structurally intact. Its own `StudioHeader`, `EditorShell`, `PreviewPane`, `TimelinePane`, `StudioLeftSidebar`, `StudioRightPanel`, `TimelineToolbar`, and timeline components are not recolored or reimplemented.

Do not make the foundation depend on undocumented Studio extension slots. The supported unit is the complete official Studio app plus its public server and selection contracts.

If same-origin embedding is not stable, open the exact pinned Hyperframes Studio/preview server as the full editor. Do not reconstruct the editor from low-level exported components.

### No-duplicate-timeline rule

Sequences must never render:

- a second timeline;
- a fake clip strip;
- a parallel keyframe model;
- a Sequences-owned playhead;
- a duplicate timeline zoom control;
- a second drag/resize/split implementation.

The only editable timeline is the official Hyperframes timeline.

The Sequences shell may render:

- a review timecode label;
- candidate/active player controls;
- QA proof-time markers outside Studio;
- a narrow review scrubber backed by the Hyperframes player.

Those controls must not claim to edit the composition.

## Visual language

### Shell color tokens

| Token | Value | Use |
|---|---|---|
| `canvas` | `#F4F0E8` | Main Sequences background |
| `surface` | `#FCFAF5` | Cards, drawers, chat surface |
| `surface-subtle` | `#EEE9E1` | Secondary sections, attachment tray |
| `surface-strong` | `#E4DED4` | Selected rows, disabled wells |
| `ink` | `#202124` | Primary text |
| `graphite` | `#17191C` | Strong labels, dark data surfaces |
| `muted` | `#6C6A66` | Secondary text |
| `quiet` | `#746F68` | Tertiary text and metadata; 4.77:1 on `surface` |
| `border` | `#D8D1C7` | Standard rules |
| `border-strong` | `#B8AFA3` | Active boundaries |
| `cobalt` | `#2457D6` | Primary action, focus, links |
| `cobalt-hover` | `#173EA9` | Hover and pressed action |
| `cobalt-soft` | `#E8EEFF` | Cobalt selection background |
| `amber` | `#9A5900` | Stale, attention, review-needed; 5.29:1 on `surface` |
| `amber-soft` | `#FFF1D6` | Amber background |
| `red` | `#B42318` | Hard failure, destructive action |
| `red-soft` | `#FDE8E7` | Error background |
| `green` | `#18794E` | Verified pass only |
| `green-soft` | `#E1F2E8` | Verified background |

Cobalt is the only shell action color. Green is not used for ordinary success or decoration; it means a verification gate passed.

Hyperframes Studio retains its own tokens, including:

- body `#0A0A0A`;
- shell canvas `#18181B`;
- panel `#0C0C0E`;
- panel surface `#18181B`;
- panel border `#1E1E1E`;
- active accent `#3CE6AC`.

Sequences must not recolor those surfaces to match the warm shell.

### Typography

| Role | Stack | Weight | Size |
|---|---|---:|---:|
| Display | `Space Grotesk, Inter, system-ui, sans-serif` | 600 | 30–48px |
| Shell UI | `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | 400–650 | 12–14px |
| Section label | `Inter, sans-serif` | 650 | 11px, uppercase, 0.08em |
| Metadata | `IBM Plex Mono, "SF Mono", "Fira Code", monospace` | 400–500 | 11–12px |
| Timecode | `IBM Plex Mono, "SF Mono", monospace` | 500 | 11px, tabular numerals |
| Studio UI | Preserve Hyperframes fonts and existing system stack | Existing | Existing |

Use sentence case for titles and actions. Uppercase is reserved for small labels, run IDs, stage names, and technical metadata.

Bundle only permissively licensed font files with the app and never fetch fonts at runtime. Until those assets are pinned and attributed, use the listed system fallbacks.

### Spacing

Use a 4px base grid:

`4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80`

Rules:

- standard control gap: 8px;
- form field gap: 12px;
- card section gap: 16px;
- major section gap: 32px;
- page inset: 24px desktop, 16px compact;
- chat transcript row padding: 16px 0;
- drawer section padding: 12px;
- never use arbitrary 5px, 7px, or 13px spacing in Sequences chrome.

### Radii

- small controls: 4px;
- cards and drawers: 8px;
- composer: 12px;
- dialogs: 12px;
- attachment thumbnails: 6px;
- status indicator: 999px only when it is truly a status indicator;
- no rounded container nesting deeper than two levels;
- no decorative oversized pills.

### Borders and elevations

- standard border: `1px solid #D8D1C7`;
- active border: `1px solid #2457D6`;
- stale border: `1px solid #9A5900`;
- error border: `1px solid #B42318`;
- no border gradients;
- no glass transparency;
- no glow effects.

Elevation is mostly created through rules and tonal contrast.

Allowed shadows:

- dialog: `0 16px 40px rgba(32, 33, 36, 0.16)`;
- menu: `0 8px 24px rgba(32, 33, 36, 0.12)`;
- selected thumbnail: `0 0 0 2px #2457D6`;
- no card shadow in the normal shell;
- no decorative shadow around chat messages.

### Iconography

Use one consistent outline icon family in Sequences, preferably the project’s existing Phosphor/Lucide-compatible set.

- standard icon: 16px;
- prominent action icon: 18px;
- toolbar icon: 14–16px;
- stroke weight: 1.75–2;
- icon-only controls require a visible tooltip and accessible label;
- use the official Hyperframes logo and icons inside Studio unchanged;
- no generated sparkle, robot head, magic wand, or gradient AI iconography.

## Component specifications

### Top bar

Height: 56px.

Left:

- Sequences wordmark in graphite;
- project name, maximum 180px with ellipsis;
- accepted commit in IBM Plex Mono.

Center:

- four-step workflow stepper;
- current step uses cobalt underline and graphite label;
- completed steps use a small cobalt check, never a green badge.

Right:

- live status text;
- `Receipt`;
- `Export`.

The top bar remains warm even when the Studio below is dark, making the integration boundary explicit.

### Chat composer and messages

Composer:

- width: 720px in Create mode;
- width: 100% in the Revision drawer;
- surface: `#FCFAF5`;
- border: `1px solid #B8AFA3`;
- radius: 12px;
- minimum height: 116px;
- padding: 16px;
- textarea grows to 160px maximum;
- placeholder color: `#746F68`;
- focused border: cobalt;
- focus ring: `0 0 0 3px #E8EEFF`.

Composer footer:

- attachment button;
- selected evidence count;
- keyboard hint;
- Plan, Build, or Revise action.

Messages are ruled editorial entries:

- user prompt: graphite left rule, `#EEE9E1` background;
- Codex response: no bubble, normal surface;
- metadata: mono, quiet text;
- action row: cobalt text buttons;
- system event: small timeline row with status icon and timestamp.

Do not use alternating rounded speech bubbles or avatars.

### Attachment input

The attachment control accepts:

- PNG, JPEG, WebP screenshots;
- one public HTTPS URL;
- pasted release facts;
- optional before/after pair.

Drop zone:

- 720px wide in Create mode;
- 72px minimum height;
- dashed `#B8AFA3` border only while active;
- subtle `#E8EEFF` fill during drag;
- no illustration or decorative upload cloud.

Attachment item:

- 64px thumbnail;
- 8px metadata column;
- filename;
- dimensions;
- hash prefix;
- rights status;
- remove action.

Unsupported or unsafe input is rejected in place with the cause and next safe action.

### Job progress

The job progress component is a compact vertical event ledger, not a fake progress bar.

Each stage row includes:

- stage name;
- state icon;
- elapsed time;
- last observed activity;
- current file/tool when known;
- artifact count when known.

Stages:

- preparing;
- authoring;
- verifying;
- review-ready.

Use a determinate bar only when the backend reports a trustworthy unit of work. Otherwise use a static cobalt activity rule with changing event text.

Never show:

- fabricated percentage estimates;
- hidden retry language;
- “almost done” without evidence;
- raw chain-of-thought.

Actions:

- `Cancel job`;
- `Open run details`;
- `Retry as new run` only after a terminal failure and only as an explicit new action.

### Viewer

Use the real `@hyperframes/player`.

Active/candidate viewers must use the same composition runtime as preview and export.

Viewer structure:

- black or graphite letterbox surface;
- 16:9 composition frame;
- transport controls below;
- timecode in mono;
- play/pause;
- scrub;
- fullscreen;
- capture frame;
- candidate label above the frame.

Candidate comparison labels:

- `Accepted`;
- `Candidate`;
- `Immutable sample`.

Labels must remain visible in screenshots.

The viewer does not use a custom canvas or HTML recreation of the composition.

### Timeline boundary

The timeline boundary is a Sequences-owned frame around the complete official Hyperframes Studio surface. `TimelinePane` remains mounted and owned inside Studio.

It may add:

- a 1px warm-to-dark boundary label above the Studio;
- candidate/accepted state outside the Studio;
- a small `Open review` link;
- a stale indicator tied to the selected evidence graph.

It must not add:

- tracks;
- clips;
- playhead;
- keyframe diamonds;
- zoom controls;
- drag handles;
- timeline editing gestures.

The existing Hyperframes timeline geometry remains authoritative:

- 32px timeline gutter;
- 48px track height;
- 24px ruler;
- 50px top track padding;
- 72px bottom track padding;
- 3px visible resize seam;
- 8px pointer target;
- minimum timeline height 100px;
- minimum preview height 120px.

### Context and selection panel

Default width: 320px.

Header:

- `Revision context`;
- selected state indicator;
- `Open Studio inspector` action.

Selection summary:

- human-readable element name;
- stable `hfId`;
- source file;
- scene;
- current time;
- accepted/candidate base commit.

Evidence section:

- linked source thumbnail;
- claim text;
- evidence hash prefix;
- stale or approved status.

Revision section:

- natural-language request;
- scope summary;
- `Keep other scenes unchanged` checkbox selected by default;
- `Create candidate` action.

No selection state shows:

`Select an element in the viewer or timeline to anchor a revision.`

The panel must never imply that a revision is global unless the user explicitly expands its scope.

### Candidate and QA surfaces

Review uses four synchronized views:

1. active and candidate Hyperframes players;
2. semantic change summary;
3. source diff with allowed and unexpected paths;
4. QA findings with clickable scene, `hfId`, time, and snapshot evidence.

Candidate header:

- candidate ID;
- base commit;
- run ID;
- affected scenes;
- changed files;
- created timestamp;
- current state.

Semantic summary example:

`Scene 2 · proof-card · 00:06.40–00:09.20 · 1 component changed`

Actions:

- `Open in Studio`;
- `Apply`;
- `Reject`;
- `Create revision`;
- `Revert` for accepted history.

QA groups:

- Hyperframes lint;
- runtime and layout;
- motion and keyframes;
- contrast;
- determinism;
- evidence and claim integrity;
- changed morph proof frames.

Hard failures disable Apply.

Advisory findings may be acknowledged and promoted with an explicit decision recorded in the receipt.

### Toasts

Toasts are reserved for completion and recovery feedback.

Placement:

- bottom-right of the Sequences shell;
- 16px from viewport edges;
- maximum width: 360px;
- above the timeline when in Editor mode.

Toast structure:

- status icon;
- concise title;
- one sentence of detail;
- optional action;
- dismiss button.

Use:

- `Candidate ready`;
- `Candidate applied`;
- `Candidate rejected`;
- `Export complete`;
- `Studio refreshed`;
- `Run cancelled`.

Do not use toasts for critical errors that require user action.

### Dialogs

Dialogs are used for:

- cancel confirmation when work is active;
- Apply confirmation when a candidate changes multiple scenes;
- Reject reason;
- Revert confirmation;
- missing dependency instructions.

Dialog geometry:

- width: 480px;
- padding: 24px;
- radius: 12px;
- shadow: dialog elevation;
- backdrop: solid `rgba(23, 25, 28, 0.34)`, no blur;
- primary action on the right;
- destructive action uses red only when destructive.

A stale candidate must not show an Apply confirmation. It must show the stale-base explanation and a safe next action.

## Complete state model

Every state is persisted and rendered explicitly.

| State | Visual treatment | Allowed actions |
|---|---|---|
| Empty | Centered Create chat with no transcript | Add evidence, type brief, open sample |
| Composing | Centered composer with attachments and draft facts | Edit, remove attachments, Plan |
| Authoring | Centered job ledger with live elapsed time and Cancel | Cancel, open run details |
| Verifying | Job ledger switches to deterministic gate rows | Cancel if still cancellable, open artifacts |
| Review-ready | Review workspace with Apply/Reject disabled until hard gates are known | Compare, open Studio, Apply, Reject, Revision |
| Failed | Red error panel with owned cause, run ID, logs, and preserved candidate | Open details, retry as new run, return to project |
| Cancelled | Neutral terminal state with elapsed time and preserved partial artifacts | Return to project, retry explicitly |
| Timed out | Amber terminal state with timeout threshold and last activity | Open artifacts, retry explicitly |
| Missing dependency | Environment panel naming the exact missing tool/version | Copy fix, re-run doctor, open immutable sample |
| Immutable sample/offline | Persistent `IMMUTABLE SAMPLE` or `OFFLINE REPLAY` label | View, scrub, inspect, duplicate locally; no live Apply or model job |
| No selection | Context drawer explains how to select an element | Select in viewer/timeline, open Studio inspector |
| Stale base | Amber banner identifies accepted commit mismatch and dependent evidence | Refresh candidate, create new scoped revision, reject |
| Unsupported input | Inline source error with URL/file reason | Remove, replace, or use owned fixture |
| Waiting for approval | Plan or candidate is paused with one explicit decision | Approve, reject, or edit request |

State transitions:

```text
empty
  -> composing
  -> authoring
  -> verifying
  -> review-ready
       -> applying -> applied
       -> rejected
       -> stale
  authoring/verifying
       -> failed
       -> cancelled
       -> timed out
```

There are no hidden transitions from failure to sample mode, and no automatic repair or retry cascade.

## Interaction model

### General interaction rules

- Apply, Reject, Revert, Plan, Build, and Revision are explicit user actions.
- User edits in Studio use Hyperframes’ existing undo/redo system.
- AI edits are isolated in candidate workspaces.
- Accepted state is not mutated while a candidate is being authored or verified.
- Apply rechecks `accepted HEAD === baseCommit`.
- A stale candidate cannot be merged silently.
- Selection context always includes the current scene and time.
- Evidence replacement preserves the old version and marks only dependent claims and scenes stale.

### Keyboard behavior

Sequences shell:

- `Cmd/Ctrl + K`: focus the active Codex composer;
- `Cmd/Ctrl + Enter`: submit the current Plan, Build, or Revision action;
- `Escape`: close a drawer or cancel composer focus;
- `Tab` / `Shift + Tab`: follow logical visual order;
- `Enter`: activate focused action;
- `Space`: play/pause only when focus is on a player and not an input.

Hyperframes Studio:

- Studio owns all editing shortcuts while focus is inside `/editor`;
- preserve current shortcuts, including `J/K/L` playback, `V` and `B` tools, `S` split, `I/O` work-area controls, and the documented keyframe commands;
- preserve arrow-key resizing for panel and timeline separators;
- do not globally intercept keys that Studio uses.

Focus order:

1. global top bar;
2. current mode content;
3. primary action;
4. secondary actions;
5. status and receipt links.

### Resize behavior

- Studio left panel: 160px minimum, 50vw maximum;
- Studio right inspector: 160px minimum, 600px maximum;
- Sequences drawer: 280px minimum, 420px maximum;
- timeline: 100px minimum;
- preview: 120px minimum;
- all visible seams are 3px with an 8px hit target;
- separators expose `role="separator"`, orientation, value, minimum, and maximum;
- pointer and keyboard resizing must update the same persisted preference.

A drawer opening should not reset the timeline height, playhead position, or horizontal timeline scroll.

### Motion

Shell transitions:

- drawer open/close: 160ms;
- toast enter/exit: 160ms;
- mode transition from centered chat to review: 220ms opacity plus horizontal translation;
- focus and selection: 120ms;
- easing: `cubic-bezier(0.22, 1, 0.36, 1)`.

Do not animate:

- every chat message;
- every list item on mount;
- decorative background elements;
- status icons continuously;
- candidate cards with bounce or scale;
- completed progress rows after they settle.

Job progress updates should change content in place. The layout must remain stable while events arrive.

### Reduced motion

Under `prefers-reduced-motion: reduce`:

- remove drawer translation;
- remove toast animation;
- remove mode transition;
- keep opacity changes under 80ms or remove them;
- preserve all state and focus feedback through borders, labels, and color;
- never rely on animation to communicate authoring progress.

## Accessibility

- Use landmarks: `header`, `main`, `aside`, `section`, and `footer`.
- Give the centered chat a named region: `Codex authoring conversation`.
- Give each player a unique accessible label.
- Use `aria-live="polite"` for job progress and `aria-live="assertive"` for terminal errors.
- Do not expose raw JSONL or model chain-of-thought.
- Never use color as the only status signal.
- Pair every status color with a label and icon.
- Maintain visible 2px cobalt focus rings.
- Keep shell text and controls at WCAG AA contrast.
- Use keyboard-operable file input, drag-and-drop alternatives, drawers, separators, dialogs, viewers, and Studio controls.
- Preserve Hyperframes’ existing keyboard accessibility and focus behavior inside the embedded Studio.
- Announce candidate readiness, failure, cancellation, timeout, and stale-base conditions.
- Keep captions/transcript support available for rendered video review.
- Make the immutable sample state persistent and unambiguous.

## Responsive behavior

Desktop is the honest editing target.

### 1200px and wider

Use the full geometry described above.

### 1024–1199px

- keep the centered Create chat at a maximum width of 680px;
- collapse the Studio left sidebar by default;
- use the official Studio right inspector only when selected;
- make Sequences drawers full-height overlays within their slot;
- preserve the timeline at a minimum of 100px;
- keep the viewer at 16:9 and prioritize it over secondary panels.

### 900–1023px

- Create mode remains fully usable;
- Review mode stacks candidate players vertically;
- Editor mode shows the official Studio with one panel open at a time;
- show a clear `Best on a desktop viewport` note near the editor;
- never shrink the timeline into an unreadable strip.

### Below 900px

- support centered chat, evidence intake, status, and read-only review;
- show the Hyperframes viewer with basic transport;
- provide `Open full Studio on desktop`;
- do not claim that mobile editing is supported;
- do not render a miniature fake timeline.

## Future-ready structure without false affordances

The data model and panel architecture should anticipate:

- reusable components;
- Hyperframes primitives;
- local and generated assets;
- camera movement;
- scene transitions;
- component morph specifications;
- evidence-to-component links;
- future QA categories.

The Sequences shell should not add empty tabs named `Components`, `Camera`, `Transitions`, or `Assets` merely because those features may arrive later. Preserve the official Studio's existing functional Assets and Blocks surfaces.

Prepare for them through:

- versioned preset locks;
- stable `hfId` selection context;
- source/evidence dependency links;
- scene and time intervals in receipts;
- a scoped Revision object;
- a QA finding taxonomy;
- a candidate diff model;
- a shared motion policy sidecar.

Future functionality should enter through the existing Create, Context, Revision, and QA surfaces rather than through a second editor.

## Implementation sequencing

### Foundation

1. Establish the warm Sequences shell and 56px top bar.
2. Add explicit Create, Edit, and Review modes.
3. Implement centered chat geometry with empty, composing, approval, and failure states.
4. Mount the exact pinned Hyperframes Studio through the same-origin integration path.
5. Preserve the official Studio header, viewer, panels, timeline, resizing, selection, and undo/redo.
6. Add the Sequences Context surface outside Studio; use a sibling drawer only after the embedding contract passes, otherwise use the separate shell route.
7. Add the real Hyperframes player for accepted and candidate review.
8. Add the candidate state machine and immutable sample mode.

### Plan and Build

9. Implement evidence intake and claim approval.
10. Implement the Plan job and storyboard approval.
11. Implement Build job progress, cancellation, timeout, and terminal failure.
12. Keep all Codex file mutations in isolated candidate workspaces.
13. Add independent lint, check, keyframe, snapshot, render, and Sequences QA aggregation.
14. Implement review-ready comparison and receipts.

### Revision and trust

15. Anchor Revision requests to selected `hfId`, scene, source file, time, and base commit.
16. Implement Apply, Reject, Revert, stale-base protection, and unchanged-scene proof.
17. Add evidence replacement and selective staleness propagation.
18. Polish the golden sample, candidate comparison, proof frames, and browser screenshot states.

## Explicit non-goals

- No duplicate renderer.
- No duplicate timeline.
- No toy editor.
- No Remotion.
- No second keyframe engine.
- No alternate provider or hidden model fallback.
- No automatic critic, repair, or retry cascade.
- No silent sample fallback.
- No arbitrary private/authenticated website capture in the foundation.
- No team accounts, billing, collaboration, marketplace, or cloud persistence.
- No mobile editing.
- No generic chatbot bubble layer.
- No purple gradient, decorative AI glow, glass-card dashboard, or excessive pills.
- No fake camera, component, primitive, or transition controls before their underlying Hyperframes contracts exist.
- No broad preset gallery before one golden Feature Release preset is excellent.

## Browser screenshot acceptance checklist

The following screenshots must be possible to capture from the browser without relying on hidden state.

### Create

- [ ] Empty project shows a genuinely centered 720px Codex chat.
- [ ] No left/right dashboard rails crowd the centered composer.
- [ ] Attachment input shows screenshot thumbnail, filename, dimensions, hash prefix, and rights status.
- [ ] Unsupported evidence shows a clear inline error and safe next action.
- [ ] Plan response shows scenes, claims, evidence links, duration, and preset.
- [ ] Plan requires an explicit approval before Build begins.

### Authoring

- [ ] Build screen shows real elapsed time and observed stage activity.
- [ ] Progress does not fabricate a percentage when no numeric progress exists.
- [ ] Cancel action is visible.
- [ ] Failure, cancellation, timeout, and missing dependency states identify their cause.
- [ ] The immutable sample is visibly labeled and is never shown as a live result.

### Editor

- [ ] Accepted composition opens in the official Hyperframes viewer.
- [ ] Official Hyperframes dark Studio chrome remains visually intact.
- [ ] The actual Studio timeline is visible with real clips, ruler, playhead, keyframes, and resize seam.
- [ ] Selecting a viewer or timeline element opens Sequences Context with `hfId`, scene, source file, and time.
- [ ] `Open Studio inspector` swaps to the official inspector instead of rendering a duplicate panel beside it.
- [ ] Studio undo/redo remains available and functional.
- [ ] No Sequences-owned timeline is visible.

### Review

- [ ] Accepted and candidate players are visibly labeled and synchronized.
- [ ] Semantic diff identifies affected scene, component, time interval, and files.
- [ ] Source diff shows allowed and unexpected paths.
- [ ] QA findings distinguish hard failures from advisory findings.
- [ ] Apply is disabled for hard failures and stale base.
- [ ] Apply, Reject, and Revert produce visible state feedback.
- [ ] Receipt shows base commit, candidate commit, changed files, affected scenes, model, and QA status.

### Accessibility and responsiveness

- [ ] Keyboard focus is visible on all shell controls.
- [ ] Job progress is announced by an accessible live region.
- [ ] Error state is announced and includes a next safe action.
- [ ] Reduced-motion mode removes shell transitions without removing state feedback.
- [ ] At 1024px, the editor remains honest about desktop requirements.
- [ ] Below 900px, the product does not present a misleading miniature editor.

## Sources and influences

This specification is grounded in the local `HACKATHON_RULES.md` and `ARCHITECTURE.md`, especially their requirements for candidate isolation, truthful progress, immutable samples, inspectable diffs, and no duplicate editor systems.

The Hyperframes contracts in `vendor/hyperframes/AGENTS.md`, `vendor/hyperframes/skills/hyperframes/SKILL.md`, `vendor/hyperframes/skills/hyperframes-creative/SKILL.md`, and `vendor/hyperframes/skills/hyperframes-creative/references/design-spec.md` establish HTML composition ownership, skill routing, frame/design token discipline, and the rule that design specifications define brand rather than layout.

The current Studio source confirms the integration boundary and geometry: `EditorShell.tsx` owns the preview-plus-timeline shell; `StudioHeader.tsx` provides the official dark toolbar; `StudioLeftSidebar.tsx` and `StudioRightPanel.tsx` own Studio panels; `PreviewPane.tsx` owns the real Hyperframes viewer; `TimelinePane.tsx`, `Timeline.tsx`, and `TimelineResizeDivider.tsx` own the real editing timeline; and `studio.css`, `timelineTheme.ts`, and `timelineLayout.ts` define the dark Studio palette, clip behavior, track heights, ruler, gutters, and resize affordances.

The visual direction follows the plan’s editorial proof-desk strategy: warm neutrals and graphite for Sequences, one cobalt action color, restrained rules and typography, and Hyperframes’ dark teal-accented interface preserved as an embedded professional tool surface.

Official documentation references used for the interaction model:

- [The Hyperframes pipeline](https://hyperframes.heygen.com/guides/)
- [Timeline editing](https://hyperframes.heygen.com/guides/timeline-editing)
- [Video editor cheatsheet](https://hyperframes.heygen.com/guides/video-editor-cheatsheet)
- [SDK overview](https://hyperframes.heygen.com/sdk/overview)
- [Open Design handoff](https://hyperframes.heygen.com/guides/open-design)
