import { describe, expect, it } from "vitest";
import type { LayoutClusterV1, QaFindingV1, SequenceArtifactV1 } from "../../src/shared";
import {
  allowsContainedLayoutPeer,
  assignLayoutInspectionOwnership,
  createLayoutFileServer,
  hasActionableRawLayoutPair,
  intersectLayoutRects,
  prefixLayoutArtifactPath,
  snapLayoutCoordinate,
} from "../../src/server/layout-inspector";

describe("layout inspector geometry", () => {
  it("restores Bun's web globals after starting HyperFrames' private Node server", async () => {
    const originalRequest = globalThis.Request;
    const originalResponse = globalThis.Response;
    const lightweightRequest = class LightweightRequest extends originalRequest {};
    const lightweightResponse = class LightweightResponse extends originalResponse {};
    const start = (() => {
      Object.defineProperty(globalThis, "Request", {
        ...Object.getOwnPropertyDescriptor(globalThis, "Request"),
        value: lightweightRequest,
      });
      Object.defineProperty(globalThis, "Response", {
        ...Object.getOwnPropertyDescriptor(globalThis, "Response"),
        value: lightweightResponse,
      });
      return Promise.resolve({
        url: "http://localhost:1",
        port: 1,
        close() {},
        addPreHeadScript() {},
      });
    }) as NonNullable<Parameters<typeof createLayoutFileServer>[1]>;

    await createLayoutFileServer({ projectDir: process.cwd() }, start);

    expect(globalThis.Request).toBe(originalRequest);
    expect(globalThis.Response).toBe(originalResponse);
  });

  it("measures one collision against the smaller entity", () => {
    const intersection = intersectLayoutRects(
      { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 },
      { left: 150, top: 25, right: 250, bottom: 75, width: 100, height: 50 },
    );

    expect(intersection).toEqual({
      bbox: { left: 150, top: 25, right: 200, bottom: 75, width: 50, height: 50 },
      area: 2_500,
      percent: 50,
    });
  });

  it("does not manufacture an intersection for touching edges", () => {
    expect(
      intersectLayoutRects(
        { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
        { left: 100, top: 0, right: 200, bottom: 100, width: 100, height: 100 },
      ),
    ).toBeNull();
  });

  it("distinguishes one-box detector indeterminacy from actionable raw pairs", () => {
    expect(
      hasActionableRawLayoutPair([
        layoutFinding({ selector: "#title", relatedSelector: "#title" }),
      ]),
    ).toBe(false);
    expect(
      hasActionableRawLayoutPair([
        layoutFinding({ selector: "#title", relatedSelector: "#panel" }),
      ]),
    ).toBe(true);
    expect(
      hasActionableRawLayoutPair([
        layoutFinding({
          code: "text_occluded",
          selector: "#title",
          relatedSelector: null,
          coveredFraction: 0.6,
        }),
      ]),
    ).toBe(true);
    expect(
      hasActionableRawLayoutPair([
        {
          ...layoutFinding({ selector: "#title", relatedSelector: null }),
          geometry: {
            ...layoutFinding({ selector: "#title", relatedSelector: null }).geometry!,
            relatedBbox: {
              left: 50,
              top: 10,
              right: 150,
              bottom: 40,
              width: 100,
              height: 30,
            },
          },
        },
      ]),
    ).toBe(true);
  });

  it("allows overflow evidence to inspect the child against its clipping ancestor", () => {
    expect(allowsContainedLayoutPeer("container_overflow")).toBe(true);
    expect(allowsContainedLayoutPeer("text_box_overflow")).toBe(true);
    expect(allowsContainedLayoutPeer("clipped_text")).toBe(true);
    expect(allowsContainedLayoutPeer("content_overlap")).toBe(false);
  });

  it("snaps suggested placement coordinates to the eight-pixel grid", () => {
    expect(snapLayoutCoordinate(19)).toBe(16);
    expect(snapLayoutCoordinate(21)).toBe(24);
    expect(snapLayoutCoordinate(-5)).toBe(-8);
  });

  it("keeps artifact paths valid when the optional run prefix is empty", () => {
    expect(prefixLayoutArtifactPath("", "layout/clusters/example/inspection.json")).toBe(
      "layout/clusters/example/inspection.json",
    );
    expect(
      prefixLayoutArtifactPath("qa/attempt-1", "layout/clusters/example/inspection.json"),
    ).toBe("qa/attempt-1/layout/clusters/example/inspection.json");
  });

  it("keeps the rendered DOM composition ID separate from time-owned semantic beats", () => {
    const sequence = sharedCompositionSequence();
    const cluster: LayoutClusterV1 = {
      id: "patch-layout-cluster",
      kind: "overlap",
      status: "undeclared",
      sampleTime: 3.2,
      timeRange: [3.2, 3.3],
      findingCount: 1,
      observationCount: 1,
      beatIds: ["failed-signal", "focused-approval", "green-resolution"],
      compositionIds: ["patch-world"],
      sourceFiles: ["compositions/patch-world.html"],
      entityIds: ["focused-diff", "approval-control"],
      intentId: null,
      summary: "A focused product-surface overlap.",
      artifacts: {
        inspection: "layout/clusters/patch-layout-cluster/inspection.json",
        fullFrame: "layout/clusters/patch-layout-cluster/full-frame.png",
        crop: "layout/clusters/patch-layout-cluster/crop.png",
      },
    };

    expect(
      assignLayoutInspectionOwnership(
        [
          {
            compositionId: "authored-patch-world",
            sourceFile: "compositions/patch-world.html",
            hfId: "diff-lines",
          },
          {
            compositionId: "authored-patch-world",
            sourceFile: "compositions/patch-world.html",
            hfId: "approve-button",
          },
        ],
        cluster,
        sequence,
      ),
    ).toEqual([
      {
        beatId: "focused-approval",
        compositionId: "authored-patch-world",
        entityId: "focused-diff",
      },
      {
        beatId: "focused-approval",
        compositionId: "authored-patch-world",
        entityId: "approval-control",
      },
    ]);
  });
});

function layoutFinding({
  code = "content_overlap",
  selector,
  relatedSelector,
  coveredFraction = null,
}: {
  code?: string;
  selector: string;
  relatedSelector: string | null;
  coveredFraction?: number | null;
}): QaFindingV1 {
  return {
    command: "check",
    category: "layout",
    code,
    severity: "error",
    sourceFile: "index.html",
    selector,
    times: [1],
    message: "Measured layout issue.",
    fixHint: null,
    geometry: {
      bbox: { left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 },
      relatedSelector,
      relatedBbox: null,
      coveredFraction,
      firstSeen: 1,
      lastSeen: 2,
      occurrences: 2,
    },
    artifact: "check.json",
  };
}

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
      sharedBeat("failed-signal", 0, 2.2, "failure-signal", ["failed-copy"]),
      {
        ...sharedBeat("focused-approval", 2.2, 3.4, "focused-diff", ["diff-lines"]),
        entities: [
          { id: "focused-diff", role: "Focused diff", parts: ["diff-lines"] },
          { id: "approval-control", role: "Approval", parts: ["approve-button"] },
        ],
      },
      sharedBeat("green-resolution", 5.6, 2.4, "resolved-signal", ["resolved-copy"]),
    ],
    overlapIntents: [],
    revision: null,
  };
}

function sharedBeat(
  id: string,
  start: number,
  duration: number,
  entityId: string,
  parts: string[],
) {
  return {
    id,
    role: id,
    start,
    duration,
    purpose: id,
    claims: [],
    entities: [{ id: entityId, role: entityId, parts }],
    sourceIds: [],
    musicAnchors: [],
    proofTimes: [start + duration / 2],
    implementationFiles: ["compositions/patch-world.html"],
  };
}
