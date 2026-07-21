import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SequenceArtifactV1Schema,
  TemporalEvidenceV1Schema,
  VisualAuditReportV1Schema,
  type SequenceArtifactV1,
} from "../../src/shared";
import {
  CREATIVE_STAGE_PATHS,
  PREPRODUCTION_STAGE_PATHS,
  assertArtifactDigests,
  assertVisualAuditBindings,
  captureArtifactDigests,
  componentStagePaths,
  compositorStagePaths,
  createTemporalEvidence,
  missingPreproductionPaths,
  needsComponentArchitect,
  temporalEvidenceSnapshotTimes,
} from "../../src/server/agent-workflow";
import { sha256 } from "../../src/server/files";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("balanced workflow stage selection", () => {
  it("uses a component architect only for references or advanced component continuity", () => {
    expect(needsComponentArchitect("Animate a normal dashboard workflow", 0)).toBe(false);
    expect(needsComponentArchitect("Show a cursor completing a product workflow", 0)).toBe(false);
    expect(needsComponentArchitect("Give the interface a liquid glass treatment", 0)).toBe(true);
    expect(needsComponentArchitect("Morphing one product panel into the result", 0)).toBe(true);
    expect(needsComponentArchitect("Recreate the product from a screenshot", 0)).toBe(true);
    expect(needsComponentArchitect("Build the UI from images", 0)).toBe(true);
    expect(needsComponentArchitect("A normal workflow with a supplied reference", 1)).toBe(true);

    const sequence = launchSequence();
    sequence.transitions![0]!.kind = "match-cut";
    expect(needsComponentArchitect("A normal dashboard workflow", 0, sequence)).toBe(true);
    sequence.transitions![0]!.kind = "morph";
    expect(needsComponentArchitect("A normal dashboard workflow", 0, sequence)).toBe(true);
  });

  it("keeps preproduction and compositor write ownership disjoint", () => {
    expect(CREATIVE_STAGE_PATHS).toEqual([
      "frame.md",
      "sequence.json",
      "story/design-capsule.json",
    ]);
    expect(componentStagePaths).toEqual(["story/component-plan.json"]);
    expect(PREPRODUCTION_STAGE_PATHS).toEqual([
      "frame.md",
      "sequence.json",
      "story/design-capsule.json",
      "story/component-plan.json",
    ]);
    expect(compositorStagePaths(true)).not.toContain("story/component-plan.json");
    expect(compositorStagePaths(false)).toContain("story/component-plan.json");
    expect(compositorStagePaths(true)).toEqual(
      expect.arrayContaining(["index.html", "compositions/**", "index.motion.json"]),
    );
  });

  it("detects a starter preproduction artifact that the director did not replace", () => {
    expect(
      missingPreproductionPaths([
        "frame.md",
        "story/design-capsule.json",
        "story/component-plan.json",
      ]),
    ).toEqual(["sequence.json"]);
    expect(missingPreproductionPaths(PREPRODUCTION_STAGE_PATHS)).toEqual([]);
  });
});

describe("workflow artifact locks", () => {
  it("captures exact bytes and rejects a changed or missing locked artifact", async () => {
    const root = await temporaryRoot("sequences-workflow-lock-");
    await mkdir(join(root, "story"), { recursive: true });
    await writeFile(join(root, "frame.md"), "design\n", "utf8");
    await writeFile(join(root, "story", "design-capsule.json"), "{}\n", "utf8");

    const digests = await captureArtifactDigests(root, [
      "frame.md",
      "story/design-capsule.json",
      "frame.md",
    ]);
    expect(digests).toEqual([
      { path: "frame.md", sha256: sha256("design\n"), bytes: 7 },
      { path: "story/design-capsule.json", sha256: sha256("{}\n"), bytes: 3 },
    ]);
    await expect(assertArtifactDigests(root, digests)).resolves.toBeUndefined();

    await writeFile(join(root, "frame.md"), "changed\n", "utf8");
    await expect(assertArtifactDigests(root, digests)).rejects.toThrow(
      "Locked workflow artifact changed or disappeared: frame.md",
    );
    await rm(join(root, "frame.md"));
    await expect(assertArtifactDigests(root, digests)).rejects.toThrow(
      "Locked workflow artifact changed or disappeared: frame.md",
    );
  });
});

describe("temporal evidence", () => {
  it("labels transit and landed frames from beats, transitions, and camera phases", async () => {
    const root = await temporaryRoot("sequences-temporal-evidence-");
    const snapshotRoot = join(root, "qa", "attempt-1", "snapshots");
    await mkdir(snapshotRoot, { recursive: true });
    await writeFile(join(root, "qa", "attempt-1", "qa.json"), "{}\n", "utf8");
    const artifacts = [
      "frame-00-at-0.500s.png",
      "frame-01-at-0.800s.png",
      "frame-02-at-1.000s.png",
      "frame-03-at-1.200s.png",
      "frame-04-at-2.967s.png",
      "frame-05-at-3.300s.png",
      "frame-06-at-3.600s.png",
      "frame-07-at-2.750s.png",
    ].map((name) => `qa/attempt-1/snapshots/${name}`);
    for (const artifact of artifacts) {
      await writeFile(join(root, ...artifact.split("/")), artifact, "utf8");
    }

    const evidence = await createTemporalEvidence(
      root,
      launchSequence(),
      "qa/attempt-1/qa.json",
      artifacts,
    );

    const byArtifact = new Map(evidence.frames.map((frame) => [frame.artifact, frame]));
    expect(byArtifact.get(artifacts[0]!)?.labels).toContain("camera-arrival");
    expect(byArtifact.get(artifacts[0]!)?.judgment).toBe("transit");
    expect(byArtifact.get(artifacts[1]!)?.labels).toContain("camera-settle");
    expect(byArtifact.get(artifacts[1]!)?.judgment).toBe("landed");
    expect(byArtifact.get(artifacts[2]!)?.labels).toContain("beat-proof");
    expect(byArtifact.get(artifacts[2]!)?.judgment).toBe("landed");
    expect(byArtifact.get(artifacts[3]!)?.labels).toContain("camera-hold");
    expect(byArtifact.get(artifacts[3]!)?.judgment).toBe("landed");
    expect(byArtifact.get(artifacts[4]!)?.labels).toContain("transition-pre");
    expect(byArtifact.get(artifacts[4]!)?.judgment).toBe("transit");
    expect(byArtifact.get(artifacts[5]!)?.labels).toContain("transition-mid");
    expect(byArtifact.get(artifacts[5]!)?.judgment).toBe("transit");
    expect(byArtifact.get(artifacts[6]!)?.labels).toContain("transition-landed");
    expect(byArtifact.get(artifacts[6]!)?.judgment).toBe("landed");
    expect(byArtifact.get(artifacts[7]!)?.labels).toContain("beat-near-end-hold");
    expect(byArtifact.get(artifacts[7]!)?.judgment).toBe("landed");
    expect(evidence.frames.every((frame) => frame.sha256 === sha256(frame.artifact))).toBe(true);
    expect(new Set(evidence.frames.map(({ at }) => at)).size).toBe(evidence.frames.length);
    expect(evidence.frames.length).toBeLessThanOrEqual(40);
    expect(
      evidence.frames.every(
        (frame) => frame.at === Number(/-at-(\d+(?:\.\d+)?)s/.exec(frame.artifact)?.[1]),
      ),
    ).toBe(true);

    const persisted = JSON.parse(
      await readFile(join(root, "workflow", "temporal-evidence.json"), "utf8"),
    );
    expect(persisted).toEqual(evidence);
  });

  it("never relabels an untimed or distant QA frame as semantic proof", async () => {
    const root = await temporaryRoot("sequences-temporal-evidence-mismatch-");
    await mkdir(join(root, "qa", "attempt-1", "snapshots"), { recursive: true });
    await writeFile(join(root, "qa", "attempt-1", "qa.json"), "{}\n", "utf8");
    const artifacts = [
      "qa/attempt-1/snapshots/frame-00-at-2.500s.png",
      "qa/attempt-1/snapshots/frame-without-time.png",
    ];
    for (const artifact of artifacts) {
      await writeFile(join(root, ...artifact.split("/")), artifact, "utf8");
    }

    const evidence = await createTemporalEvidence(
      root,
      launchSequence(),
      "qa/attempt-1/qa.json",
      artifacts,
    );

    expect(evidence.frames).toEqual([]);
  });

  it("selects exact opening, beat proof, camera, transition, and final-hold instants", () => {
    expect(temporalEvidenceSnapshotTimes(launchSequence())).toEqual([
      0, 0.5, 0.8, 1, 1.2, 2.75, 2.967, 3.3, 3.6, 4, 5.75,
    ]);
  });

  it("prioritizes bounded typing and pointer phases with semantic labels", async () => {
    const root = await temporaryRoot("sequences-interaction-evidence-");
    const sequence = launchSequence();
    sequence.audio = {
      soundtrackId: "confident-commercial",
      cues: [
        { kind: "mouse-click", atSec: 3.05 },
        { kind: "typing", startSec: 5.6, endSec: 6 },
      ],
    };

    const times = temporalEvidenceSnapshotTimes(sequence, 6);
    expect(times).toEqual([3, 3.05, 3.25, 5.6, 5.8, 5.999]);
    expect(times).toHaveLength(6);
    expect(temporalEvidenceSnapshotTimes(sequence, 4)).toHaveLength(4);

    const snapshotRoot = join(root, "qa", "attempt-1", "snapshots");
    await mkdir(snapshotRoot, { recursive: true });
    await writeFile(join(root, "qa", "attempt-1", "qa.json"), "{}\n", "utf8");
    const artifacts = times.map(
      (at, index) =>
        `qa/attempt-1/snapshots/frame-${String(index).padStart(2, "0")}-at-${at.toFixed(3)}s.png`,
    );
    for (const artifact of artifacts) {
      await writeFile(join(root, ...artifact.split("/")), artifact, "utf8");
    }

    const evidence = await createTemporalEvidence(
      root,
      sequence,
      "qa/attempt-1/qa.json",
      artifacts,
    );
    const byLabel = new Map(
      evidence.frames.flatMap((frame) => frame.labels.map((label) => [label, frame] as const)),
    );
    expect(byLabel.get("pointer-approach")).toMatchObject({
      at: 3,
      beatId: "product-proof",
      judgment: "transit",
    });
    expect(byLabel.get("pointer-contact")).toMatchObject({
      at: 3.05,
      beatId: "product-proof",
      judgment: "transit",
    });
    expect(byLabel.get("pointer-consequence")).toMatchObject({
      at: 3.25,
      beatId: "product-proof",
      judgment: "landed",
    });
    expect(byLabel.get("typing-start")).toMatchObject({
      at: 5.6,
      beatId: "product-proof",
      judgment: "transit",
    });
    expect(byLabel.get("typing-mid")).toMatchObject({
      at: 5.8,
      beatId: "product-proof",
      judgment: "transit",
    });
    expect(byLabel.get("typing-end")).toMatchObject({
      at: 5.999,
      beatId: "product-proof",
      judgment: "landed",
    });
  });

  it("rejects audit findings that are not bound to the temporal packet", () => {
    const sequence = launchSequence();
    const evidence = TemporalEvidenceV1Schema.parse({
      version: "sequences.temporal-evidence.v1",
      duration: 8,
      qaArtifact: "qa/attempt-1/qa.json",
      frames: [
        {
          id: "temporal-01",
          at: 1,
          judgment: "landed",
          beatId: "hook",
          transitionId: null,
          entityIds: ["product-window"],
          labels: ["beat-proof"],
          artifact: "qa/attempt-1/snapshots/frame-00-at-1.0s.png",
          sha256: "f".repeat(64),
        },
      ],
    });
    const report = VisualAuditReportV1Schema.parse({
      version: "sequences.visual-audit.v1",
      evidenceArtifact: "workflow/temporal-evidence.json",
      verdict: "repair",
      summary: "One issue remains.",
      findings: [
        {
          id: "camera-landing",
          severity: "minor",
          category: "camera",
          beatIds: ["hook"],
          entityIds: ["product-window"],
          frameIds: ["missing-frame"],
          timeRange: [1, 2],
          observation: "The landing is abrupt.",
          repairIntent: "Ease the final settle.",
        },
      ],
    });

    expect(() => assertVisualAuditBindings(report, evidence, sequence)).toThrow(
      "unknown frame missing-frame",
    );
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function launchSequence(): SequenceArtifactV1 {
  return SequenceArtifactV1Schema.parse({
    version: "sequences.sequence.v1",
    format: { width: 1920, height: 1080, fps: 30, targetDuration: 6 },
    concept: {
      summary: "One product action resolves into proof.",
      hierarchy: ["Action", "Proof"],
      motionGrammar: ["Camera travel", "Identity handoff"],
      rejectedChoices: [],
    },
    beats: [
      {
        id: "product-action",
        role: "product-action",
        start: 0,
        duration: 3,
        purpose: "Show the operated product action.",
        claims: [],
        entities: [{ id: "product-panel", role: "Persistent product panel", parts: [] }],
        sourceIds: [],
        musicAnchors: [],
        proofTimes: [1],
        implementationFiles: ["compositions/02-product.html"],
        camera: {
          owner: "dom-world",
          targetEntityId: "product-panel",
          startPose: { x: 0, y: 0, z: 0, scale: 1, rotationX: 0, rotationY: 0, rotationZ: 0 },
          endPose: { x: 40, y: -20, z: 0, scale: 1.2, rotationX: 0, rotationY: 0, rotationZ: 0 },
          arrival: 0.5,
          settle: 0.8,
          hold: 1.2,
        },
      },
      {
        id: "product-proof",
        role: "product-proof",
        start: 3,
        duration: 3,
        purpose: "Land on the resulting product state.",
        claims: [],
        entities: [{ id: "result-panel", role: "Resolved product panel", parts: [] }],
        sourceIds: [],
        musicAnchors: [],
        proofTimes: [4],
        implementationFiles: ["compositions/02-product.html"],
      },
    ],
    transitions: [
      {
        id: "action-to-proof",
        fromBeatId: "product-action",
        toBeatId: "product-proof",
        kind: "dissolve",
        at: 3,
        duration: 0.6,
        rationale: "Carry the operated state into its proof.",
      },
    ],
    overlapIntents: [],
    revision: null,
  });
}
