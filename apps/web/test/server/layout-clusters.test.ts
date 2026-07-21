import { describe, expect, it } from "vitest";
import { LayoutClusterV1Schema, type QaFindingV1, type SequenceArtifactV1 } from "../../src/shared";
import { buildLayoutClusters, matchNarrowOverlapIntent } from "../../src/server/layout-clusters";

describe("layout root-cause clustering", () => {
  it("collapses the 20 compose-to-receipt descendants into one handoff cluster", () => {
    const findings = handoffFindings();
    const clusters = buildLayoutClusters(findings, sequence());

    expect(clusters).toHaveLength(1);
    const cluster = LayoutClusterV1Schema.parse(clusters[0]);
    expect(cluster).toMatchObject({
      kind: "handoff",
      status: "undeclared",
      sampleTime: 10.815,
      timeRange: [10.815, 10.833],
      findingCount: 20,
      observationCount: 25,
      beatIds: ["compose-workspace", "verified-receipt"],
      compositionIds: ["composition-02-compose", "composition-03-receipt"],
      sourceFiles: ["compositions/02-compose.html", "compositions/03-receipt.html"],
      entityIds: ["compose-morph-card", "candidate-receipt"],
      intentId: null,
      summary:
        "compose-workspace → verified-receipt handoff caused one unresolved layout cluster at 10.815s, affecting 20 descendants.",
    });
    expect(cluster.artifacts).toEqual({
      inspection: `layout/clusters/${cluster.id}/inspection.json`,
      fullFrame: `layout/clusters/${cluster.id}/full-frame.png`,
      crop: `layout/clusters/${cluster.id}/crop.png`,
    });

    expect(buildLayoutClusters([...findings].reverse(), sequence())).toEqual(clusters);
  });

  it("requires time overlap and a causal selector edge", () => {
    const findings = [
      finding({
        sourceFile: "compositions/02-compose.html",
        selector: ".title",
        relatedSelector: ".wipe",
        time: 1,
      }),
      finding({
        sourceFile: "compositions/02-compose.html",
        selector: ".card",
        relatedSelector: ".wipe",
        time: 2,
      }),
      finding({
        category: "contrast",
        code: "contrast_aa_failure",
        sourceFile: "compositions/02-compose.html",
        selector: ".title",
        relatedSelector: null,
        time: 1,
      }),
    ];

    const clusters = buildLayoutClusters(findings, sequence());
    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.findingCount)).toEqual([1, 1]);
  });

  it("matches only one exact, time-bounded, beat-owned overlap intent", () => {
    const candidateSequence = sequence();
    candidateSequence.overlapIntents = [
      {
        id: "compose-receipt-handoff",
        kind: "handoff",
        entities: ["compose-morph-card", "candidate-receipt"],
        timeRange: [10.55, 11.05],
        zOrder: ["compose-morph-card", "candidate-receipt"],
        mustRemainReadable: ["candidate-receipt"],
        reason: "The outgoing editor reveals the verified receipt.",
      },
    ];
    const cluster = buildLayoutClusters(handoffFindings(), candidateSequence)[0]!;

    expect(cluster.intentId).toBeNull();
    expect(matchNarrowOverlapIntent(cluster, candidateSequence)?.id).toBe(
      "compose-receipt-handoff",
    );

    candidateSequence.overlapIntents.push({
      ...candidateSequence.overlapIntents[0]!,
      id: "duplicate-handoff-intent",
    });
    expect(matchNarrowOverlapIntent(cluster, candidateSequence)).toBeNull();
  });

  it("uses the measured time range when several beats share one implementation composition", () => {
    const candidateSequence = sharedCompositionSequence();
    const clusters = buildLayoutClusters(
      [
        finding({
          sourceFile: "compositions/patch-world.html",
          selector: ".failed-state",
          relatedSelector: ".surface",
          time: 1,
        }),
        finding({
          sourceFile: "C:\\candidate\\compositions\\patch-world.html",
          selector: ".focused-diff",
          relatedSelector: ".surface",
          time: 2.2,
        }),
        finding({
          sourceFile: "compositions/patch-world.html",
          selector: ".resolved-state",
          relatedSelector: ".surface",
          time: 6.2,
        }),
      ],
      candidateSequence,
    );

    expect(clusters.map((cluster) => cluster.beatIds)).toEqual([
      ["failed-signal"],
      ["focused-approval"],
      ["green-resolution"],
    ]);
    expect(clusters.map((cluster) => cluster.compositionIds)).toEqual([
      ["patch-world"],
      ["patch-world"],
      ["patch-world"],
    ]);
  });

  it("splits one normalized shared-file finding across its measured beat owners", () => {
    const sampled = finding({
      sourceFile: "compositions/patch-world.html",
      selector: ".same",
      relatedSelector: ".surface",
      time: 1,
      observationCount: 2,
    });
    sampled.times = [1, 6.2];
    sampled.geometry = {
      bbox: null,
      relatedSelector: ".surface",
      relatedBbox: null,
      coveredFraction: null,
      firstSeen: 1,
      lastSeen: 6.2,
      occurrences: 2,
    };

    const clusters = buildLayoutClusters([sampled], sharedCompositionSequence());

    expect(clusters.map((cluster) => cluster.beatIds)).toEqual([
      ["failed-signal"],
      ["green-resolution"],
    ]);
    expect(clusters.map((cluster) => cluster.timeRange)).toEqual([
      [1, 1],
      [6.2, 6.2],
    ]);
  });

  it("recognizes a semantic handoff sampled exactly at a shared-world beat boundary", () => {
    const candidateSequence: SequenceArtifactV1 = {
      version: "sequences.sequence.v1",
      concept: {
        summary: "Morph one card into another in one world.",
        hierarchy: ["Outgoing", "Incoming"],
        motionGrammar: ["Identity handoff"],
        rejectedChoices: [],
      },
      beats: [
        sharedBeat("outgoing-beat", 0, 2.2, "outgoing-card"),
        sharedBeat("incoming-beat", 2.2, 2.8, "incoming-card"),
      ],
      overlapIntents: [
        {
          id: "card-handoff",
          kind: "handoff",
          entities: ["outgoing-card", "incoming-card"],
          timeRange: [2.1, 2.3],
          zOrder: ["outgoing-card", "incoming-card"],
          mustRemainReadable: ["incoming-card"],
          reason: "The incoming card resolves above the outgoing card.",
        },
      ],
      revision: null,
    };
    const boundary = finding({
      sourceFile: "compositions/patch-world.html",
      selector: "#outgoing-card",
      relatedSelector: "#incoming-card",
      time: 2.2,
    });
    boundary.geometry = {
      bbox: null,
      relatedSelector: "#incoming-card",
      relatedBbox: null,
      coveredFraction: null,
      firstSeen: 2.19,
      lastSeen: 2.21,
      occurrences: 2,
    };

    const clusters = buildLayoutClusters([boundary], candidateSequence);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      kind: "handoff",
      beatIds: ["outgoing-beat", "incoming-beat"],
      entityIds: ["outgoing-card", "incoming-card"],
      timeRange: [2.19, 2.21],
    });
    expect(matchNarrowOverlapIntent(clusters[0]!, candidateSequence)?.id).toBe("card-handoff");
  });

  it("clusters persistent container overflow for repair without treating it as overlap intent", () => {
    const candidateSequence = sharedCompositionSequence();
    const overflow = finding({
      code: "container_overflow",
      sourceFile: "compositions/patch-world.html",
      selector: "#product-surface",
      relatedSelector: "#viewport",
      time: 2.5,
    });
    overflow.severity = "warning";

    const clusters = buildLayoutClusters([overflow], candidateSequence);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      kind: "overflow",
      status: "undeclared",
      beatIds: ["focused-approval"],
      compositionIds: ["patch-world"],
    });
    expect(matchNarrowOverlapIntent(clusters[0]!, candidateSequence)).toBeNull();
  });
});

function sharedCompositionSequence(): SequenceArtifactV1 {
  return {
    version: "sequences.sequence.v1",
    concept: {
      summary: "Repair one failed build in a persistent product surface.",
      hierarchy: ["Failure", "Approval", "Resolution"],
      motionGrammar: ["One persistent world"],
      rejectedChoices: [],
    },
    beats: [
      sharedBeat("failed-signal", 0, 2.2, "failure-signal"),
      sharedBeat("focused-approval", 2.2, 3.4, "focused-diff"),
      sharedBeat("green-resolution", 5.6, 2.4, "resolved-signal"),
    ],
    overlapIntents: [],
    revision: null,
  };
}

function sharedBeat(id: string, start: number, duration: number, entityId: string) {
  return {
    id,
    role: id,
    start,
    duration,
    purpose: id,
    claims: [],
    entities: [{ id: entityId, role: entityId, parts: [] }],
    sourceIds: [],
    musicAnchors: [],
    proofTimes: [start + duration / 2],
    implementationFiles: ["compositions/patch-world.html"],
  };
}

function sequence(): SequenceArtifactV1 {
  return {
    version: "sequences.sequence.v1",
    concept: {
      summary: "Turn evidence into a verified release.",
      hierarchy: ["Evidence", "Compose", "Receipt"],
      motionGrammar: ["Measured handoffs"],
      rejectedChoices: [],
    },
    beats: [
      {
        id: "compose-workspace",
        purpose: "Compose the release in an inspectable workspace.",
        claims: [],
        entities: [{ id: "compose-morph-card", role: "The outgoing editor.", parts: [] }],
        sourceIds: [],
        musicAnchors: [],
        proofTimes: [10],
        implementationFiles: ["compositions/02-compose.html"],
      },
      {
        id: "verified-receipt",
        purpose: "Confirm the verified candidate.",
        claims: [],
        entities: [{ id: "candidate-receipt", role: "The incoming receipt.", parts: [] }],
        sourceIds: [],
        musicAnchors: [],
        proofTimes: [11.2],
        implementationFiles: ["compositions/03-receipt.html"],
      },
    ],
    overlapIntents: [],
    revision: null,
  };
}

function handoffFindings(): QaFindingV1[] {
  const composeSelectors = [
    "div.card-number",
    "div.clip-bar.keyframe",
    "div.clip-bar.one",
    "div.clip-bar.three",
    "div.clip-bar.two",
    "div.field-name",
    "div.field-value",
    "div.field-value.identity",
    "div.micro-label",
    "div.panel-label",
    "div.rail-item",
    "div.rail-item.active",
    "div.track-labels > span:nth-of-type(1)",
    "div.track-labels > span:nth-of-type(2)",
    "div.track-labels > span:nth-of-type(3)",
    "span.canvas-title-line",
    "span.result-check",
    "span.selection-tag",
  ];
  const duplicateObservations = new Set([
    "div.clip-bar.keyframe",
    "div.field-name",
    "div.field-value",
    "div.rail-item",
    "span.canvas-title-line",
  ]);
  return [
    ...composeSelectors.map((selector, index) =>
      finding({
        sourceFile: "compositions/02-compose.html",
        selector,
        relatedSelector: index < 13 ? "div.copy" : "div.receipt-wrap",
        observationCount: duplicateObservations.has(selector) ? 2 : 1,
      }),
    ),
    finding({
      code: "text_occluded",
      sourceFile: "compositions/03-receipt.html",
      selector: "div.copy",
      relatedSelector: "div.rail-item.active",
    }),
    finding({
      code: "text_occluded",
      sourceFile: "C:\\candidate\\compositions\\03-receipt.html",
      selector: "div.receipt-wrap",
      relatedSelector: "div.canvas-grid",
    }),
  ];
}

function finding(options: {
  category?: string;
  code?: string;
  sourceFile: string;
  selector: string;
  relatedSelector: string | null;
  time?: number;
  observationCount?: number;
}): QaFindingV1 {
  const time = options.time ?? 10.815;
  return {
    command: "check",
    category: options.category ?? "layout",
    code: options.code ?? "content_overlap",
    severity: "error",
    sourceFile: options.sourceFile,
    selector: options.selector,
    times: [time],
    message: "Two rendered entities collide.",
    fixHint: null,
    observationCount: options.observationCount ?? 1,
    geometry: {
      bbox: null,
      relatedSelector: options.relatedSelector,
      relatedBbox: null,
      coveredFraction: null,
      firstSeen: time,
      lastSeen: time === 10.815 ? 10.833 : time,
      occurrences: 2,
    },
    artifact: "qa/attempt-1/check.json",
  };
}
