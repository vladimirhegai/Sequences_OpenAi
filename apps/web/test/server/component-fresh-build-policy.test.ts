import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertComponentPlan,
  canonicalizeComponentPlanStateClaims,
  normalizeComponentPlanContainment,
  normalizeComponentPlanReferenceBindings,
} from "../../src/server/component-plan";
import { assertDesignCapsule } from "../../src/server/design-capsule";
import {
  assertFreshBuildAuthored,
  assertLaunchSequenceSemantics,
} from "../../src/server/sequence-artifact";
import {
  ComponentPlanV2Schema,
  SequenceArtifactV1Schema,
  type ComponentPlanV2,
  type SequenceArtifactV1,
} from "../../src/shared";
import { authorFreshBuildFixture, FRESH_BUILD_ARTIFACTS } from "./fresh-build-fixture";

const roots: string[] = [];
const shellRoot = join(process.cwd(), "fixtures", "saas-shell");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fresh-build component plan", () => {
  it("accepts a synthetic component bound to real reusable product UI", async () => {
    const { root, sequence } = await authoredProject();

    const plan = await assertAuthoredComponentPlan(root, sequence);

    expect(plan.mode).toBe("synthetic");
    expect(plan.components[0]).toMatchObject({
      archetype: "workflow",
      continuity: "persistent",
      id: "workflow-panel",
      rootHfId: "hf-shell-window",
      usedInBeatIds: ["product-action", "product-proof"],
    });
  });

  it("rejects a component plan bound to a different design capsule", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.designCapsuleId = "other-design";
    });

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "designCapsuleId must bind to proof-workflow-design",
    );
  });

  it("rejects a reserved component token that drifts from the design capsule", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.tokens["color-accent"] = "#000000";
    });

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "token color-accent must match design capsule value #1E2BFA",
    );
  });

  it("rejects a component that claims an unknown sequence beat", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.usedInBeatIds = ["product-action", "missing-beat"];
    });

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "references unknown beat missing-beat",
    );
  });

  it("rejects reference-derived mode when the host supplied no images", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.mode = "reference-derived";
    });

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "mode must be synthetic",
    );
  });

  it("rejects a root whose data-component does not match its typed archetype", async () => {
    const { root, sequence } = await authoredProject();
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        'data-component="workflow"',
        'data-component="button"',
      ),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      'root must declare data-component="workflow"',
    );
  });

  it("rejects a declared part whose data-hf-id is absent", async () => {
    const { root, sequence } = await authoredProject();
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        'data-hf-id="hf-shell-main-title"',
        'data-hf-id="different-title"',
      ),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "part workflow-status must bind to exactly one data-hf-id (found 0)",
    );
  });

  it("relocates one unambiguous sibling part under its declared component root", async () => {
    const { root, sequence } = await authoredProject();
    const compositionPath = join(root, "compositions", "02-compose.html");
    const part = '<h2 id="shell-main-title" data-hf-id="hf-shell-main-title">Overview</h2>';
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8"))
        .replace(part, "")
        .replace('<section id="shell-window"', `${part}\n        <section id="shell-window"`),
      "utf8",
    );
    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "part workflow-status must be inside its component root",
    );

    await expect(normalizeComponentPlanContainment(root)).resolves.toEqual({
      changed: true,
      movedParts: [
        {
          componentId: "workflow-panel",
          partId: "workflow-status",
          implementationFile: "compositions/02-compose.html",
        },
      ],
    });

    await expect(assertAuthoredComponentPlan(root, sequence)).resolves.toBeDefined();
    const normalized = await readFile(compositionPath, "utf8");
    expect(normalized.match(/data-hf-id="hf-shell-main-title"/g)).toHaveLength(1);
    expect(normalized).toContain("window.__timelines");
  });

  it("reconciles one unambiguous recreated reference to the locked beat binding", async () => {
    const { root } = await authoredProject();
    const imagePath = "assets/derived/reference.png";
    await mutatePlan(root, (plan) => {
      plan.mode = "reference-derived";
      plan.sourceImages = [imagePath];
      plan.sourceImageBindings = [
        {
          imagePath,
          beatIds: ["product-action", "product-proof"],
          narrativeRole: "proof",
          purpose: "The recreated product state proves the action and result.",
        },
      ];
      plan.sourceEvidence = "The supplied reference defines the recreated product state.";
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        'data-hf-id="hf-shell-window"',
        `data-hf-id="hf-shell-window" data-reference-image="${imagePath}" data-reference-mode="recreated" data-reference-beats="product-action"`,
      ),
      "utf8",
    );

    await expect(normalizeComponentPlanReferenceBindings(root)).resolves.toEqual({
      changed: true,
      normalizedBindings: [
        {
          imagePath,
          implementationFile: "compositions/02-compose.html",
          beforeBeatIds: "product-action",
          afterBeatIds: "product-action product-proof",
        },
      ],
    });
    expect(await readFile(compositionPath, "utf8")).toContain(
      `data-reference-image="${imagePath}" data-reference-mode="recreated" data-reference-beats="product-action product-proof"`,
    );
    await expect(normalizeComponentPlanReferenceBindings(root)).resolves.toEqual({
      changed: false,
      normalizedBindings: [],
    });
  });

  it("does not accept an HTML comment as data-hf-id evidence", async () => {
    const { root, sequence } = await authoredProject();
    const compositionPath = join(root, "compositions", "02-compose.html");
    const withoutRealPart = (await readFile(compositionPath, "utf8")).replace(
      'data-hf-id="hf-shell-main-title"',
      'data-hf-id="different-title"',
    );
    await writeFile(
      compositionPath,
      `${withoutRealPart}\n<!-- <span data-hf-id="hf-shell-main-title"></span> -->\n`,
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "part workflow-status must bind to exactly one data-hf-id (found 0)",
    );
  });

  it("rejects a declared component state that is not implemented", async () => {
    const { root, sequence } = await authoredProject();
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace('data-state="ready"', 'data-state="idle"'),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "state workflow-panel/ready is not implemented on its root",
    );
  });

  it("accepts an alternate state implemented by root-scoped CSS", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push({
        id: "complete",
        description: "The workflow shows the resolved result.",
      });
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        "</style>",
        '[data-hf-id="hf-shell-window"][data-state="complete"] { opacity: 1; }\n      </style>',
      ),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).resolves.toBeDefined();
  });

  it("accepts an alternate state implemented by the actual root id selector", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push({
        id: "complete",
        description: "The workflow shows the resolved result.",
      });
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        "</style>",
        '#shell-window[data-state="complete"] { opacity: 1; }\n      </style>',
      ),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).resolves.toBeDefined();
  });

  it("accepts an alternate state invoked on the root by the GSAP timeline", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push({
        id: "complete",
        description: "The workflow shows the resolved result.",
      });
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        "</script>",
        `tl.set('#shell-window', { attr: { 'data-state': 'complete' } }, 4);\n</script>`,
      ),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).resolves.toBeDefined();
  });

  it("accepts a root-bound timeline state helper and direct dataset assignment", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push(
        { id: "complete", description: "The workflow shows the result." },
        { id: "settled", description: "The workflow reaches its hold." },
      );
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        "</script>",
        [
          `const workflow = document.querySelector(root + '#shell-window');`,
          `const setState = (element, state) => { element.dataset.state = state };`,
          `tl.call(() => setState(workflow, 'complete'), [], 4);`,
          `tl.call(() => { workflow.dataset.state = 'settled' }, [], 5);`,
          "</script>",
        ].join("\n"),
      ),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).resolves.toBeDefined();
  });

  it("accepts root states invoked through a scoped selector helper", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push(
        { id: "helper-complete", description: "The workflow shows the result." },
        { id: "helper-settled", description: "The workflow reaches its hold." },
      );
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        "</script>",
        [
          `const $ = (selector) => root.querySelector(selector);`,
          `const other = $('#other'), workflow = $('#shell-window');`,
          `tl.set($('#shell-window'), { attr: { 'data-state': 'helper-complete' } }, 4);`,
          `tl.set(workflow, { attr: { 'data-state': 'helper-settled' } }, 5);`,
          "</script>",
        ].join("\n"),
      ),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).resolves.toBeDefined();
  });

  it("accepts root states invoked through a shorthand scoped selector helper", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push(
        { id: "helper-complete", description: "The workflow shows the result." },
        { id: "helper-settled", description: "The workflow reaches its hold." },
      );
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        "</script>",
        [
          `const q = selector => root.querySelector(selector);`,
          `const other = q('#other'), workflow = q('#shell-window');`,
          `tl.set(q('#shell-window'), { attr: { 'data-state': 'helper-complete' } }, 4);`,
          `tl.set(workflow, { attr: { 'data-state': 'helper-settled' } }, 5);`,
          "</script>",
        ].join("\n"),
      ),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).resolves.toBeDefined();
  });

  it("does not confuse a lookalike id selector with the actual component root", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push({
        id: "complete",
        description: "The workflow shows the resolved result.",
      });
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        "</style>",
        '#shell-window-copy[data-state="complete"] { opacity: 1; }\n      </style>',
      ),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "state workflow-panel/complete is not implemented on its root",
    );
  });

  it("reports every unimplemented root state in one validation result", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push(
        {
          id: "complete",
          description: "The workflow shows the resolved result.",
        },
        {
          id: "failed",
          description: "The workflow exposes a recoverable failure.",
        },
      );
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace('data-state="ready"', 'data-state="idle"'),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      /has 3 unimplemented root states:[\s\S]*workflow-panel\/ready[\s\S]*workflow-panel\/complete[\s\S]*workflow-panel\/failed/,
    );
  });

  it("canonicalizes unimplemented state claims and their dependent interactions", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push(
        {
          id: "complete",
          description: "The workflow shows the resolved result.",
        },
        {
          id: "phantom",
          description: "This state is claimed but not implemented.",
        },
      );
      plan.components[0]!.interactions = [
        {
          id: "complete-workflow",
          kind: "resolve",
          cause: "The workflow completes.",
          result: "The result is shown.",
          fromState: "ready",
          toState: "complete",
        },
        {
          id: "enter-phantom",
          kind: "resolve",
          cause: "An unsupported transition is claimed.",
          result: "An unsupported state would be shown.",
          fromState: "ready",
          toState: "phantom",
        },
      ];
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        "</style>",
        '#shell-window[data-state="complete"] { opacity: 1; }\n      </style>',
      ),
      "utf8",
    );

    const result = await canonicalizeComponentPlanStateClaims(root);

    expect(result).toEqual({
      changed: true,
      removedStates: [{ componentId: "workflow-panel", stateIds: ["phantom"] }],
      removedInteractions: [{ componentId: "workflow-panel", interactionIds: ["enter-phantom"] }],
    });
    const plan = ComponentPlanV2Schema.parse(
      JSON.parse(await readFile(join(root, "story", "component-plan.json"), "utf8")) as unknown,
    );
    expect(plan.components[0]!.states.map((state) => state.id)).toEqual(["ready", "complete"]);
    expect(plan.components[0]!.interactions.map((interaction) => interaction.id)).toEqual([
      "complete-workflow",
    ]);
    await expect(assertAuthoredComponentPlan(root, sequence)).resolves.toBeDefined();
  });

  it("does not canonicalize away the plan's last multi-state or interactive component", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push({
        id: "phantom",
        description: "This state is claimed but not implemented.",
      });
      plan.components[0]!.interactions = [
        {
          id: "enter-phantom",
          kind: "resolve",
          cause: "An unsupported transition is claimed.",
          result: "An unsupported state would be shown.",
          fromState: "ready",
          toState: "phantom",
        },
      ];
    });
    const planPath = join(root, "story", "component-plan.json");
    const before = await readFile(planPath, "utf8");

    await expect(canonicalizeComponentPlanStateClaims(root)).resolves.toEqual({
      changed: false,
      removedStates: [],
      removedInteractions: [],
    });
    expect(await readFile(planPath, "utf8")).toBe(before);
    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "state workflow-panel/phantom is not implemented on its root",
    );
  });

  it("does not accept a CSS comment as alternate-state evidence", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.states.push({
        id: "complete",
        description: "The workflow shows the resolved result.",
      });
    });
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      (await readFile(compositionPath, "utf8")).replace(
        "</style>",
        '/* [data-hf-id="hf-shell-window"][data-state="complete"] { opacity: 1; } */\n      </style>',
      ),
      "utf8",
    );

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "state workflow-panel/complete is not implemented on its root",
    );
  });

  it("does not accept a sibling state marker as implementation on the component root", async () => {
    const { root, sequence } = await authoredProject();
    const compositionPath = join(root, "compositions", "02-compose.html");
    const composition = (await readFile(compositionPath, "utf8"))
      .replace('data-state="ready"', 'data-state="idle"')
      .replace("<body>", '<body>\n    <div id="state-sibling" data-state="ready"></div>');
    await writeFile(compositionPath, composition, "utf8");

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "state workflow-panel/ready is not implemented on its root",
    );
  });

  it("rejects beat-local coverage even when it spans every sequence beat", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.continuity = "beat-local";
    });

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "needs at least one persistent component reused across the sequence",
    );
  });

  it("rejects a persistent component reused in only one sequence beat", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.usedInBeatIds = ["product-action"];
    });

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "persistent component workflow-panel must bind to at least 2 sequence beats",
    );
  });

  it("reports structural and root-state mismatches in one repair packet", async () => {
    const { root, sequence } = await authoredProject();
    await mutatePlan(root, (plan) => {
      plan.components[0]!.usedInBeatIds = ["product-action"];
      plan.components[0]!.states.push({
        id: "phantom",
        description: "This state is declared but not implemented.",
      });
    });

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      /found 2 mismatches:[\s\S]*persistent component workflow-panel must bind to at least 2 sequence beats[\s\S]*state workflow-panel\/phantom is not implemented on its root/,
    );
  });

  it("rejects a used beat that omits the component semantic entity", async () => {
    const { root, sequence } = await authoredProject();
    sequence.beats[1]!.entities = [];

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "component workflow-panel must be a semantic entity in beat product-proof",
    );
  });

  it("rejects a used beat whose implementation files are disjoint from the component", async () => {
    const { root, sequence } = await authoredProject();
    sequence.beats[1]!.implementationFiles = ["compositions/03-proof.html"];

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "component workflow-panel must share an implementation file with beat product-proof",
    );
  });

  it("rejects a morph anchor missing from a used beat's semantic parts", async () => {
    const { root, sequence } = await authoredProject();
    sequence.beats[1]!.entities[0]!.parts = [];

    await expect(assertAuthoredComponentPlan(root, sequence)).rejects.toThrow(
      "morph anchor workflow-panel/workflow-status must be a semantic part in beat product-proof",
    );
  });
});

describe("fresh-build authorship gate", () => {
  it("accepts an authored launch that replaces the generic starter", async () => {
    const { root, sequence } = await authoredProject();

    await expect(
      assertFreshBuildAuthored(root, sequence, FRESH_BUILD_ARTIFACTS),
    ).resolves.toBeUndefined();
  });

  it("reports independent fresh-build authorship mismatches in one packet", async () => {
    const { root, sequence } = await authoredProject();
    sequence.concept.summary = "Generic SaaS starter shell";

    await expect(
      assertFreshBuildAuthored(root, sequence, [
        "sequence.json",
        "story/design-capsule.json",
        "index.motion.json",
      ]),
    ).rejects.toThrow(
      /found 4 mismatches:[\s\S]*requires Luna to author frame.md[\s\S]*requires Luna to author story\/component-plan.json[\s\S]*rejected the unchanged starter sequence[\s\S]*requires a sequence-declared composition source to change/,
    );
  });

  it("rejects a comment-only composition edit even when semantic sidecars are new", async () => {
    const { root, sequence } = await authoredProject();
    const compositionPath = join(root, "compositions", "02-compose.html");
    const untouchedStarter = await readFile(
      join(shellRoot, "compositions", "02-compose.html"),
      "utf8",
    );
    await writeFile(
      compositionPath,
      `${untouchedStarter}\n<!-- Luna claims this starter is authored. -->\n`,
      "utf8",
    );

    await expect(assertFreshBuildAuthored(root, sequence, FRESH_BUILD_ARTIFACTS)).rejects.toThrow(
      "Fresh-build policy found unchanged starter content",
    );
  });

  it("rejects a transform override that suppresses declared camera motion", async () => {
    const { root, sequence } = await authoredProject();
    sequence.beats[0]!.camera = {
      owner: "dom-world",
      targetEntityId: "workflow-panel",
      startPose: {
        x: 0,
        y: 0,
        z: 0,
        scale: 1,
        rotationX: 0,
        rotationY: 0,
        rotationZ: 0,
      },
      endPose: {
        x: -120,
        y: 40,
        z: 0,
        scale: 1.25,
        rotationX: 0,
        rotationY: 0,
        rotationZ: 0,
      },
      arrival: 0.5,
      settle: 1,
      hold: 2,
    };
    const compositionPath = join(root, "compositions", "02-compose.html");
    await writeFile(
      compositionPath,
      `${await readFile(compositionPath, "utf8")}\n<style>#shell-window { transform: none !important; }</style>\n`,
      "utf8",
    );

    await expect(assertFreshBuildAuthored(root, sequence, FRESH_BUILD_ARTIFACTS)).rejects.toThrow(
      "forbids transform: none !important when sequence.json declares camera motion",
    );
  });
});

describe("launch sequence timeline semantics", () => {
  it("accepts contiguous story-ordered beats and an aligned transition", async () => {
    const { sequence } = await authoredProject();

    expect(() => assertLaunchSequenceSemantics(sequence)).not.toThrow();
  });

  it("rejects beat starts that do not follow story order", async () => {
    const sequence = await authoredSequence();
    sequence.beats[1]!.start = 0;
    sequence.beats[1]!.proofTimes = [1];

    expect(() => assertLaunchSequenceSemantics(sequence)).toThrow(
      "beat starts must follow story order",
    );
  });

  it("rejects an uncovered timeline gap between beats", async () => {
    const sequence = await authoredSequence();
    sequence.beats[1]!.start = 2.6;
    sequence.beats[1]!.duration = 2.4;
    sequence.transitions![0]!.at = 2.6;

    expect(() => assertLaunchSequenceSemantics(sequence)).toThrow(
      "beats must cover the full timeline without gaps",
    );
  });

  it("rejects a transition that is not aligned to its beat boundary", async () => {
    const sequence = await authoredSequence();
    sequence.transitions![0]!.at = 2.7;

    expect(() => assertLaunchSequenceSemantics(sequence)).toThrow(
      "must align with the product-proof boundary",
    );
  });
});

async function authoredProject(): Promise<{ root: string; sequence: SequenceArtifactV1 }> {
  const root = await mkdtemp(join(tmpdir(), "sequences-component-policy-"));
  roots.push(root);
  await cp(shellRoot, root, { recursive: true });
  await authorFreshBuildFixture(root);
  return { root, sequence: await readSequence(root) };
}

async function authoredSequence(): Promise<SequenceArtifactV1> {
  const { sequence } = await authoredProject();
  return structuredClone(sequence);
}

async function readSequence(root: string): Promise<SequenceArtifactV1> {
  return SequenceArtifactV1Schema.parse(
    JSON.parse(await readFile(join(root, "sequence.json"), "utf8")) as unknown,
  );
}

async function assertAuthoredComponentPlan(root: string, sequence: SequenceArtifactV1) {
  const designCapsule = await assertDesignCapsule(root, []);
  return assertComponentPlan(root, sequence, [], designCapsule);
}

async function mutatePlan(root: string, mutate: (plan: ComponentPlanV2) => void): Promise<void> {
  const path = join(root, "story", "component-plan.json");
  const plan = ComponentPlanV2Schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  mutate(plan);
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}
