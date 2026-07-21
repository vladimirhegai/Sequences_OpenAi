import { describe, expect, it } from "vitest";
import type {
  LayoutClusterV1,
  LayoutInspectionV1,
  QaReceiptV1,
  SequenceArtifactV1,
} from "../../src/shared";
import {
  adjudicateLayoutCluster,
  canAdjudicateLayoutFailure,
  normalizeQaFindings,
} from "../../src/server/hyperframes";
import { buildLayoutClusters, layoutFindingKey } from "../../src/server/layout-clusters";

describe("layout intent adjudication", () => {
  it("passes one exact, legible handoff while retaining its raw detector evidence", () => {
    const declared = adjudicateLayoutCluster(cluster(), inspection(true), sequence(), {
      markers: [],
      violations: [],
    });

    expect(declared).toMatchObject({
      status: "declared_legible",
      intentId: "compose-receipt-handoff",
    });
    expect(
      canAdjudicateLayoutFailure(
        commands(),
        normalizeQaFindings("check", rawLayoutFailure()),
        [declared],
        rawLayoutFailure(),
        {
          markers: [],
          violations: [],
        },
      ),
    ).toBe(true);
  });

  it("sends the cluster back when required content is unreadable or suppression is broad", () => {
    expect(
      adjudicateLayoutCluster(cluster(), inspection(false), sequence(), {
        markers: [],
        violations: [],
      }).status,
    ).toBe("declared_unreadable");
    expect(
      adjudicateLayoutCluster(cluster(), inspection(true), sequence(), {
        markers: [],
        violations: [
          {
            sourceFile: "compositions/02-compose.html",
            identity: "root",
            intentId: "compose-receipt-handoff",
            code: "overlap_marker_broad_suppression",
            message: "Root marker suppresses descendant QA.",
          },
        ],
      }).status,
    ).toBe("suppression_rejected");

    const unmeasured = inspection(true);
    unmeasured.entities[0]!.zIndex = "auto";
    expect(
      adjudicateLayoutCluster(cluster(), unmeasured, sequence(), {
        markers: [],
        violations: [],
      }).status,
    ).toBe("declared_unreadable");

    const missing = inspection(true);
    missing.entities.shift();
    expect(
      adjudicateLayoutCluster(cluster(), missing, sequence(), {
        markers: [],
        violations: [],
      }).status,
    ).toBe("declared_unreadable");
  });

  it("fails closed when raw errors are unaccounted or no measured transient was demoted", () => {
    const declared = adjudicateLayoutCluster(cluster(), inspection(true), sequence(), {
      markers: [],
      violations: [],
    });
    const raw = rawLayoutFailure();
    expect(
      canAdjudicateLayoutFailure(commands(), [], [declared], raw, {
        markers: [],
        violations: [],
      }),
    ).toBe(false);

    const persistentOnly = {
      ...raw,
      layout: { ok: false, findings: [raw.layout.findings[0]] },
    };
    expect(
      canAdjudicateLayoutFailure(
        commands(),
        normalizeQaFindings("check", persistentOnly),
        [declared],
        persistentOnly,
        { markers: [], violations: [] },
      ),
    ).toBe(false);

    const malformed = {
      ...raw,
      layout: {
        ok: false,
        findings: [{ code: "content_overlap", severity: "error" }],
      },
    };
    expect(
      canAdjudicateLayoutFailure(commands(), [], [declared], malformed, {
        markers: [],
        violations: [],
      }),
    ).toBe(false);
  });

  it("accounts for one normalized blocker split across several shared-file beat clusters", () => {
    const raw = sharedFileLayoutFailure();
    const findings = normalizeQaFindings("check", raw);
    const clusters = buildLayoutClusters(findings, sharedFileSequence()).map((cluster) => ({
      ...cluster,
      status: "declared_legible" as const,
    }));

    expect(clusters.map((cluster) => cluster.beatIds)).toEqual([["one"], ["two"], ["three"]]);
    expect(
      canAdjudicateLayoutFailure(commands(), findings, clusters, raw, {
        markers: [],
        violations: [],
      }),
    ).toBe(true);
  });

  it("does not let one same-time cluster account for an unlocatable blocker", () => {
    const raw = unlocatableLayoutFailure();
    const findings = normalizeQaFindings("check", raw);
    const clusters = buildLayoutClusters(findings, sharedFileSequence()).map((cluster) => ({
      ...cluster,
      status: "declared_legible" as const,
    }));

    expect(clusters).toHaveLength(1);
    expect(
      canAdjudicateLayoutFailure(commands(), findings, clusters, raw, {
        markers: [],
        violations: [],
      }),
    ).toBe(false);
  });
});

function sharedFileSequence(): SequenceArtifactV1 {
  return {
    version: "sequences.sequence.v1",
    concept: {
      summary: "One shared surface across three beats.",
      hierarchy: ["One", "Two", "Three"],
      motionGrammar: ["Persistent surface"],
      rejectedChoices: [],
    },
    beats: [sharedBeat("one", 0, 2.2), sharedBeat("two", 2.2, 3.4), sharedBeat("three", 5.6, 2.4)],
    overlapIntents: [],
    revision: null,
  };
}

function sharedBeat(id: string, start: number, duration: number) {
  return {
    id,
    role: id,
    start,
    duration,
    purpose: id,
    claims: [],
    entities: [{ id: `${id}-entity`, role: id, parts: [] }],
    sourceIds: [],
    musicAnchors: [],
    proofTimes: [start + duration / 2],
    implementationFiles: ["compositions/shared.html"],
  };
}

function sharedFileLayoutFailure() {
  const persistent = [1, 2.2, 6.2].map((time) => ({
    code: "content_overlap",
    severity: "error" as const,
    time,
    sourceFile: "compositions/shared.html",
    selector: ".same",
    containerSelector: ".surface",
    message: "The same overlap persists across the shared product surface.",
    firstSeen: 1,
    lastSeen: 6.2,
    occurrences: 3,
  }));
  return {
    ok: false,
    layout: {
      ok: false,
      findings: [
        ...persistent,
        {
          code: "text_occluded",
          severity: "error" as const,
          time: 4,
          sourceFile: "compositions/shared.html",
          selector: ".transient",
          message: "Short measured handoff seam.",
          firstSeen: 4,
          lastSeen: 4.1,
          occurrences: 2,
        },
      ],
    },
    lint: { ok: true },
    runtime: { ok: true },
    motion: { ok: true },
    contrast: { ok: true },
  };
}

function unlocatableLayoutFailure() {
  return {
    ok: false,
    layout: {
      ok: false,
      findings: [
        {
          code: "content_overlap",
          severity: "error" as const,
          time: 1,
          sourceFile: "compositions/shared.html",
          selector: "#one-entity",
          containerSelector: "#surface",
          message: "Clusterable blocker.",
          firstSeen: 1,
          lastSeen: 1.4,
          occurrences: 3,
        },
        {
          code: "content_overlap",
          severity: "error" as const,
          time: 1,
          sourceFile: "compositions/shared.html",
          message: "Unlocatable blocker.",
          firstSeen: 1,
          lastSeen: 1.4,
          occurrences: 3,
        },
        {
          code: "text_occluded",
          severity: "error" as const,
          time: 1.5,
          sourceFile: "compositions/shared.html",
          selector: ".transient",
          message: "Short measured seam.",
          firstSeen: 1.5,
          lastSeen: 1.6,
          occurrences: 2,
        },
      ],
    },
    lint: { ok: true },
    runtime: { ok: true },
    motion: { ok: true },
    contrast: { ok: true },
  };
}

function cluster(): LayoutClusterV1 {
  return {
    id: "compose-receipt-cluster",
    kind: "handoff",
    status: "undeclared",
    sampleTime: 10.815,
    timeRange: [10.815, 10.833],
    findingCount: 1,
    observationCount: 2,
    beatIds: ["compose-workspace", "verified-receipt"],
    compositionIds: ["compose-workspace", "verified-receipt"],
    sourceFiles: ["compositions/02-compose.html", "compositions/03-receipt.html"],
    entityIds: ["compose-card", "receipt-card"],
    findingKeys: [
      layoutFindingKey(
        normalizeQaFindings("check", rawLayoutFailure()).find(
          (finding) => finding.severity === "error",
        )!,
      ),
    ],
    intentId: null,
    summary: "One handoff cluster.",
    artifacts: {
      inspection: "layout/clusters/compose-receipt-cluster/inspection.json",
      fullFrame: "layout/clusters/compose-receipt-cluster/full-frame.png",
      crop: "layout/clusters/compose-receipt-cluster/crop.png",
    },
  };
}

function inspection(readable: boolean): LayoutInspectionV1 {
  const rect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
  return {
    clusterId: "compose-receipt-cluster",
    sampleTime: 10.815,
    canvas: rect,
    safeArea: rect,
    grid: { columns: 12, rows: 8, columnGap: 8, rowGap: 8, margin: 0 },
    entities: [
      {
        identity: {
          beatId: "compose-workspace",
          compositionId: "compose-workspace",
          entityId: "compose-card",
          hfId: "compose-card",
          selector: ".compose-card",
        },
        bbox: rect,
        opacity: 1,
        zIndex: 1,
        stackingContexts: [],
        parentContentBox: rect,
        lineBoxes: [rect],
        readabilityOwner: "compose-card",
        readable: true,
      },
      {
        identity: {
          beatId: "verified-receipt",
          compositionId: "verified-receipt",
          entityId: "receipt-card",
          hfId: "receipt-card",
          selector: ".receipt-card",
        },
        bbox: rect,
        opacity: 1,
        zIndex: 2,
        stackingContexts: [],
        parentContentBox: rect,
        lineBoxes: [rect],
        readabilityOwner: "receipt-card",
        readable,
      },
    ],
    intersections: [
      { entityIds: ["compose-card", "receipt-card"], bbox: rect, area: 10_000, percent: 100 },
    ],
    guides: [],
    availableRegions: [],
    suggestedPositions: [],
    policyViolations: [],
  };
}

function sequence(): SequenceArtifactV1 {
  return {
    version: "sequences.sequence.v1",
    concept: {
      summary: "Compose then verify.",
      hierarchy: ["Compose", "Receipt"],
      motionGrammar: ["Handoff"],
      rejectedChoices: [],
    },
    beats: [
      {
        id: "compose-workspace",
        purpose: "Compose.",
        claims: [],
        entities: [{ id: "compose-card", role: "Outgoing card.", parts: [] }],
        sourceIds: [],
        musicAnchors: [],
        proofTimes: [10],
        implementationFiles: ["compositions/02-compose.html"],
      },
      {
        id: "verified-receipt",
        purpose: "Verify.",
        claims: [],
        entities: [{ id: "receipt-card", role: "Incoming receipt.", parts: [] }],
        sourceIds: [],
        musicAnchors: [],
        proofTimes: [12],
        implementationFiles: ["compositions/03-receipt.html"],
      },
    ],
    overlapIntents: [
      {
        id: "compose-receipt-handoff",
        kind: "handoff",
        entities: ["compose-card", "receipt-card"],
        timeRange: [10.55, 11.05],
        zOrder: ["compose-card", "receipt-card"],
        mustRemainReadable: ["receipt-card"],
        reason: "The receipt resolves above the outgoing editor.",
      },
    ],
    revision: null,
  };
}

function commands(): QaReceiptV1["commands"] {
  return [
    { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
    { command: "check", ok: false, exitCode: 1, durationMs: 1, artifact: "check.json" },
  ];
}

function rawLayoutFailure() {
  return {
    ok: false,
    layout: {
      ok: false,
      findings: [
        {
          code: "content_overlap",
          severity: "error" as const,
          time: 10.815,
          sourceFile: "compositions/02-compose.html",
          selector: ".compose-card",
          message: "Handoff entities overlap.",
        },
        {
          code: "text_occluded",
          severity: "error" as const,
          time: 10.82,
          sourceFile: "compositions/03-receipt.html",
          selector: ".receipt-card",
          message: "Two sampled frames catch the handoff seam.",
          firstSeen: 10.81,
          lastSeen: 10.82,
          occurrences: 2,
        },
      ],
    },
    lint: { ok: true },
    runtime: { ok: true },
    motion: { ok: true },
    contrast: { ok: true },
  };
}
