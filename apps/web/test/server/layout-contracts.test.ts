import { describe, expect, it } from "vitest";

import {
  LayoutClusterV1Schema,
  LayoutInspectionV1Schema,
  OverlapIntentV1Schema,
} from "../../src/shared/layout-contracts";
import { SequenceArtifactV1Schema } from "../../src/shared/sequence-contracts";

const rect = {
  left: 0,
  top: 0,
  right: 100,
  bottom: 80,
  width: 100,
  height: 80,
};

const overlayIntent = {
  id: "tooltip-over-canvas",
  kind: "overlay" as const,
  entities: ["editor-canvas", "tooltip"],
  timeRange: [6.2, 7.1] as [number, number],
  zOrder: ["editor-canvas", "tooltip"],
  mustRemainReadable: ["tooltip"],
  reason: "Tooltip explains the selected control",
};

describe("OverlapIntentV1Schema", () => {
  it("accepts a narrowly scoped overlay intent", () => {
    expect(OverlapIntentV1Schema.parse(overlayIntent)).toEqual(overlayIntent);
  });

  it("accepts an empty readable set only for handoffs", () => {
    expect(
      OverlapIntentV1Schema.safeParse({
        ...overlayIntent,
        id: "compose-receipt-handoff",
        kind: "handoff",
        mustRemainReadable: [],
      }).success,
    ).toBe(true);
    expect(
      OverlapIntentV1Schema.safeParse({ ...overlayIntent, mustRemainReadable: [] }).success,
    ).toBe(false);
  });

  it("rejects broad, ambiguous, and overlong declarations", () => {
    expect(
      OverlapIntentV1Schema.safeParse({
        ...overlayIntent,
        entities: ["editor-canvas", "tooltip", "tooltip"],
        zOrder: ["editor-canvas", "tooltip", "tooltip"],
      }).success,
    ).toBe(false);
    expect(
      OverlapIntentV1Schema.safeParse({
        ...overlayIntent,
        zOrder: ["editor-canvas", "receipt"],
      }).success,
    ).toBe(false);
    expect(
      OverlapIntentV1Schema.safeParse({
        ...overlayIntent,
        timeRange: [6.2, 9.21],
      }).success,
    ).toBe(false);
    expect(
      OverlapIntentV1Schema.safeParse({
        ...overlayIntent,
        mustRemainReadable: ["receipt"],
      }).success,
    ).toBe(false);
  });
});

describe("SequenceArtifactV1Schema overlap intents", () => {
  it("defaults overlapIntents and retains typed declarations", () => {
    const sequence = {
      version: "sequences.sequence.v1",
      concept: {
        summary: "Show the compose to receipt story",
        hierarchy: ["Compose", "Receipt"],
        motionGrammar: ["Direct handoff"],
      },
      beats: [
        {
          id: "compose",
          purpose: "Compose a message",
          entities: [
            { id: "editor-canvas", role: "Compose surface", parts: [] },
            { id: "message-card", role: "Message", parts: ["tooltip"] },
          ],
          proofTimes: [6.5],
          implementationFiles: ["src/compositions/compose.html"],
        },
      ],
    };

    expect(SequenceArtifactV1Schema.parse(sequence).overlapIntents).toEqual([]);
    expect(
      SequenceArtifactV1Schema.parse({ ...sequence, overlapIntents: [overlayIntent] })
        .overlapIntents,
    ).toEqual([overlayIntent]);
  });

  it("rejects unknown and ambiguous overlap entity references", () => {
    const base = {
      version: "sequences.sequence.v1" as const,
      concept: {
        summary: "Show a tooltip",
        hierarchy: ["Canvas", "Tooltip"],
        motionGrammar: ["Overlay"],
      },
      beats: [
        {
          id: "compose",
          purpose: "Compose a message",
          entities: [
            { id: "editor-canvas", role: "Compose surface", parts: [] },
            { id: "message-card", role: "Message", parts: ["tooltip"] },
          ],
          proofTimes: [6.5],
          implementationFiles: ["src/compositions/compose.html"],
        },
      ],
      overlapIntents: [overlayIntent],
    };

    expect(
      SequenceArtifactV1Schema.safeParse({
        ...base,
        overlapIntents: [
          {
            ...overlayIntent,
            entities: ["editor-canvas", "missing-tooltip"],
            zOrder: ["editor-canvas", "missing-tooltip"],
            mustRemainReadable: ["missing-tooltip"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SequenceArtifactV1Schema.safeParse({
        ...base,
        beats: [
          ...base.beats,
          {
            id: "receipt",
            purpose: "Show a receipt",
            entities: [{ id: "receipt-card", role: "Receipt", parts: ["tooltip"] }],
            proofTimes: [10.9],
            implementationFiles: ["src/compositions/receipt.html"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts one stable semantic identity recurring across beats", () => {
    const recurringBeat = {
      purpose: "Keep the same workspace visible",
      entities: [
        { id: "editor-canvas", role: "Persistent canvas", parts: [] },
        { id: "message-card", role: "Persistent message", parts: ["tooltip"] },
      ],
      proofTimes: [7],
      implementationFiles: ["src/compositions/compose.html"],
    };
    const sequence = {
      version: "sequences.sequence.v1" as const,
      concept: {
        summary: "Keep the tooltip attached to one persistent workspace",
        hierarchy: ["Canvas", "Tooltip"],
        motionGrammar: ["Overlay"],
      },
      beats: [
        { id: "compose", ...recurringBeat },
        { id: "resolve", ...recurringBeat },
      ],
      overlapIntents: [overlayIntent],
    };

    expect(SequenceArtifactV1Schema.safeParse(sequence).success).toBe(true);
  });
});

describe("layout evidence receipts", () => {
  it("validates a clustered handoff and its bounded inspection packet", () => {
    const cluster = {
      id: "compose-receipt-handoff",
      kind: "handoff" as const,
      status: "undeclared" as const,
      sampleTime: 10.815,
      timeRange: [10.8, 10.833] as [number, number],
      findingCount: 20,
      observationCount: 40,
      beatIds: ["compose", "receipt"],
      compositionIds: ["compose-workspace", "receipt-scene"],
      sourceFiles: [
        "src/compositions/compose-workspace.html",
        "src/compositions/receipt-scene.html",
      ],
      entityIds: ["compose-panel", "receipt-card"],
      intentId: null,
      summary: "Compose to receipt handoff caused one unresolved layout cluster",
      artifacts: {
        inspection: "qa/layout/compose-receipt-handoff.json",
        fullFrame: "qa/layout/compose-receipt-handoff.png",
        crop: "qa/layout/compose-receipt-handoff-crop.png",
      },
    };
    const inspection = {
      clusterId: cluster.id,
      sampleTime: cluster.sampleTime,
      canvas: { ...rect, right: 1920, bottom: 1080, width: 1920, height: 1080 },
      safeArea: { left: 96, top: 54, right: 1824, bottom: 1026, width: 1728, height: 972 },
      grid: { columns: 12, rows: 8, columnGap: 24, rowGap: 24, margin: 96 },
      entities: [
        {
          identity: {
            beatId: "compose",
            compositionId: "compose-workspace",
            entityId: "compose-panel",
            hfId: "compose-panel",
            selector: "[data-hf-id='compose-panel']",
          },
          bbox: rect,
          opacity: 1,
          zIndex: 2,
          stackingContexts: ["#root", ".compose-scene"],
          parentContentBox: rect,
          lineBoxes: [],
          readabilityOwner: null,
          readable: true,
        },
        {
          identity: {
            beatId: "receipt",
            compositionId: "receipt-scene",
            entityId: "receipt-card",
            hfId: "receipt-card",
            selector: "[data-hf-id='receipt-card']",
          },
          bbox: rect,
          opacity: 0.8,
          zIndex: "auto" as const,
          stackingContexts: ["#root", ".receipt-scene"],
          parentContentBox: rect,
          lineBoxes: [rect],
          readabilityOwner: "receipt-card",
          readable: false,
        },
      ],
      intersections: [
        {
          entityIds: ["compose-panel", "receipt-card"],
          bbox: rect,
          area: 8_000,
          percent: 100,
        },
      ],
      guides: [
        {
          id: "safe-left",
          kind: "safe-area" as const,
          axis: "x" as const,
          position: 96,
          distance: 24,
          entityIds: ["receipt-card"],
        },
      ],
      availableRegions: [{ id: "right-rail", bbox: rect, area: 8_000 }],
      suggestedPositions: [
        {
          entityId: "receipt-card",
          bbox: rect,
          guideIds: ["safe-left"],
          reason: "Align the incoming card to the safe-area guide",
        },
      ],
      policyViolations: [],
    };

    expect(LayoutClusterV1Schema.safeParse(cluster).success).toBe(true);
    expect(LayoutInspectionV1Schema.safeParse(inspection).success).toBe(true);
  });

  it("rejects inconsistent summary counts and samples outside the cluster range", () => {
    const invalid = {
      id: "bad-cluster",
      kind: "overlap",
      status: "undeclared",
      sampleTime: 5,
      timeRange: [6, 7],
      findingCount: 3,
      observationCount: 2,
      beatIds: ["compose"],
      compositionIds: ["compose-workspace"],
      sourceFiles: ["src/compositions/compose.html"],
      entityIds: ["canvas", "tooltip"],
      intentId: null,
      summary: "Invalid cluster",
      artifacts: {
        inspection: "qa/layout/inspection.json",
        fullFrame: "qa/layout/frame.png",
        crop: "qa/layout/crop.png",
      },
    };

    expect(LayoutClusterV1Schema.safeParse(invalid).success).toBe(false);
  });
});
