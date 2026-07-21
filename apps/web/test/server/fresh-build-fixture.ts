import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FRESH_BUILD_ARTIFACTS = [
  "compositions/02-compose.html",
  "sequence.json",
  "frame.md",
  "story/design-capsule.json",
  "story/component-plan.json",
  "index.motion.json",
] as const;

export async function authorFreshBuildFixture(root: string): Promise<void> {
  const compositionPath = join(root, "compositions", "02-compose.html");
  const composition = (await readFile(compositionPath, "utf8"))
    .replace("A calmer way to ship work.", "Turn one product action into visible proof.")
    .replace("This is the starter story.", "A real workflow moves from request to result.")
    .replace("acme.app/overview", "proof.app/workflow")
    .replace(
      `--shell-brand: #2745d6;
          --shell-brand-soft: #c9d4ff;
          --shell-ink: #171a21;
          --shell-ink-muted: #454c5c;
          --shell-label: #5a6274;
          --shell-surface: #ffffff;
          --shell-surface-dim: #f7f8fc;
          --shell-line: #e3e6ee;`,
      `--shell-brand: #1E2BFA;
          --shell-brand-soft: #D8D2C6;
          --shell-ink: #111418;
          --shell-ink-muted: #5B6066;
          --shell-label: #5B6066;
          --shell-surface: #FFFFFF;
          --shell-surface-dim: #FDFAF3;
          --shell-accent-text: #FFFFFF;
          --shell-line: #D8D2C6;`,
    )
    .replace(
      `color: var(--shell-ink);
          font-family: Montserrat, sans-serif;`,
      `color: var(--shell-ink);
          background: var(--shell-surface-dim);
          font-family: Montserrat, sans-serif;`,
    )
    .replace(
      `background: var(--shell-ink);
          color: #ffffff;
          font-size: 21px;
          font-weight: 700;`,
      `background: var(--shell-brand);
          color: var(--shell-accent-text);
          font-size: 21px;
          font-weight: 600;`,
    )
    .replace(
      `background: var(--shell-brand);
          color: #ffffff;
          font-size: 16px;`,
      `background: var(--shell-brand);
          color: var(--shell-accent-text);
          font-size: 16px;`,
    )
    .replaceAll("font-weight: 800;", "font-weight: 900;")
    .replace(
      'id="shell-window" data-hf-id="hf-shell-window"',
      'id="shell-window" data-hf-id="hf-shell-window" data-component="workflow" data-state="ready"',
    );
  await writeFile(compositionPath, composition, "utf8");

  await writeFile(
    join(root, "frame.md"),
    `---
version: sequences.frame.v1
capsule: proof-workflow-design
---

# Proof workflow design frame

Use Signal Light as the visual foundation: warm restraint, calm product geometry, and one decisive cobalt signal.

- Background: \`#FDFAF3\`
- Surface: \`#FFFFFF\`
- Text: \`#111418\`
- Muted text: \`#5B6066\`
- Accent: \`#1E2BFA\`
- Accent text: \`#FFFFFF\`
- Border: \`#D8D2C6\`
- Display and body: Montserrat
- Technical labels: IBM Plex Mono
`,
    "utf8",
  );

  await writeFile(
    join(root, "sequence.json"),
    `${JSON.stringify(
      {
        version: "sequences.sequence.v1",
        format: { width: 1920, height: 1080, fps: 30, targetDuration: 5 },
        concept: {
          summary: "A product workflow turns one action into visible proof.",
          hierarchy: ["Product action", "Product consequence"],
          motionGrammar: ["Persistent product surface", "Decisive state handoff"],
          rejectedChoices: ["Generic dashboard montage"],
        },
        beats: [
          {
            id: "product-action",
            role: "product-action",
            start: 0,
            duration: 2.5,
            purpose: "Show the user action inside the persistent product surface.",
            claims: [],
            entities: [
              {
                id: "workflow-panel",
                role: "Persistent product workflow panel",
                parts: ["workflow-status"],
              },
            ],
            sourceIds: [],
            musicAnchors: [],
            proofTimes: [1.5],
            implementationFiles: ["compositions/02-compose.html"],
          },
          {
            id: "product-proof",
            role: "product-proof",
            start: 2.5,
            duration: 2.5,
            purpose: "Resolve the action into a readable product result.",
            claims: [],
            entities: [
              {
                id: "workflow-panel",
                role: "Persistent product workflow panel",
                parts: ["workflow-status"],
              },
            ],
            sourceIds: [],
            musicAnchors: [],
            proofTimes: [4],
            implementationFiles: ["compositions/02-compose.html"],
          },
        ],
        transitions: [
          {
            id: "action-to-proof",
            fromBeatId: "product-action",
            toBeatId: "product-proof",
            kind: "cut",
            at: 2.5,
            duration: 0,
            rationale: "The action resolves immediately into its product consequence.",
          },
        ],
        overlapIntents: [],
        revision: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await mkdir(join(root, "story"), { recursive: true });
  await writeFile(
    join(root, "story", "design-capsule.json"),
    `${JSON.stringify(
      {
        version: "sequences.design-capsule.v1",
        id: "proof-workflow-design",
        name: "Proof Workflow Signal Light",
        thesis: "Warm B2B restraint with one decisive cobalt signal and calm product geometry.",
        origin: { kind: "catalog", catalogId: "signal-light" },
        basis: "light",
        palette: {
          background: "#FDFAF3",
          surface: "#FFFFFF",
          text: "#111418",
          muted: "#5B6066",
          accent: "#1E2BFA",
          accentText: "#FFFFFF",
          border: "#D8D2C6",
        },
        typography: {
          display: { family: "Montserrat", weights: [700, 900] },
          body: { family: "Montserrat", weights: [500, 600] },
          mono: { family: "IBM Plex Mono", weights: [500, 600] },
        },
        geometry: { radiusPx: 12, borderPx: 2, shadow: "none" },
        density: "balanced",
        compositionDialect: "split-evidence",
        motionVerbs: ["cursor-cause", "state-swap", "data-resolve"],
        rules: {
          do: [
            "Keep the product workflow readable as one persistent surface.",
            "Reserve cobalt for the action and its resolved consequence.",
          ],
          avoid: [
            "Do not introduce unrelated decorative dashboards.",
            "Do not replace product causality with generic floating cards.",
          ],
        },
        rootHfId: "hf-shell-window",
        tokenBindings: {
          background: "--shell-surface-dim",
          surface: "--shell-surface",
          text: "--shell-ink",
          muted: "--shell-ink-muted",
          accent: "--shell-brand",
          accentText: "--shell-accent-text",
          border: "--shell-line",
        },
        implementationFiles: ["compositions/02-compose.html"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "story", "component-plan.json"),
    `${JSON.stringify(
      {
        version: "sequences.component-plan.v2",
        designCapsuleId: "proof-workflow-design",
        mode: "synthetic",
        name: "Proof workflow UI",
        visualThesis: "One persistent product surface changes state in place.",
        sourceImages: [],
        sourceEvidence: "Synthetic test vocabulary derived from the product brief.",
        tokens: {
          "color-background": "#FDFAF3",
          "color-surface": "#FFFFFF",
          "color-text": "#111418",
          "color-muted": "#5B6066",
          "color-accent": "#1E2BFA",
          "color-accent-text": "#FFFFFF",
          "color-border": "#D8D2C6",
          "radius-panel": 12,
        },
        components: [
          {
            id: "workflow-panel",
            archetype: "workflow",
            continuity: "persistent",
            purpose: "Carries the product action into its visible result.",
            rootHfId: "hf-shell-window",
            stateAttribute: "data-state",
            states: [{ id: "ready", description: "The workflow is ready for action." }],
            parts: [
              {
                id: "workflow-status",
                hfId: "hf-shell-main-title",
                purpose: "Names the current workflow state.",
                morphAnchor: true,
              },
            ],
            slots: [{ id: "status-copy", hfId: "hf-shell-main-title", kind: "text" }],
            interactions: [
              {
                id: "complete-workflow",
                kind: "resolve",
                cause: "The user completes the workflow.",
                result: "The same panel displays the result.",
              },
            ],
            usedInBeatIds: ["product-action", "product-proof"],
            implementationFiles: ["compositions/02-compose.html"],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    join(root, "index.motion.json"),
    `${JSON.stringify(
      {
        version: 1,
        duration: 5,
        assertions: [
          { kind: "appearsBy", selector: "#shell-lockup", bySec: 0.8 },
          { kind: "staysInFrame", selector: "#shell-window" },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
