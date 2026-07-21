import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SequenceArtifactV1 } from "../../src/shared";
import { scanOverlapPolicy, stripOverlapSuppressionMarkers } from "../../src/server/overlap-policy";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("semantic overlap policy", () => {
  it("accepts one exact marker but rejects root-level QA suppression", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-overlap-policy-"));
    roots.push(root);
    await writeFile(
      join(root, "index.html"),
      [
        '<main id="root" data-layout-allow-overlap data-layout-intent="tooltip-canvas">',
        '  <div id="tooltip" data-layout-allow-occlusion data-layout-intent="tooltip-canvas">Help</div>',
        "</main>",
      ].join("\n"),
      "utf8",
    );

    const scan = await scanOverlapPolicy(root, sequence());
    expect(scan.markers).toHaveLength(2);
    expect(scan.violations).toEqual([
      expect.objectContaining({
        identity: "root",
        intentId: "tooltip-canvas",
        code: "overlap_marker_broad_suppression",
      }),
    ]);

    expect(await stripOverlapSuppressionMarkers(root)).toBe(2);
    const stripped = await readFile(join(root, "index.html"), "utf8");
    expect(stripped).not.toContain("data-layout-allow-overlap");
    expect(stripped).not.toContain("data-layout-allow-occlusion");
    expect(stripped).toContain('data-layout-intent="tooltip-canvas"');
  });

  it("requires every marker identity to be named by its exact intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-overlap-policy-"));
    roots.push(root);
    await writeFile(
      join(root, "scene.html"),
      '<div id="floating-card" data-layout-allow-overlap data-layout-intent="tooltip-canvas"></div>',
      "utf8",
    );

    expect((await scanOverlapPolicy(root, sequence())).violations).toEqual([
      expect.objectContaining({ code: "overlap_marker_entity_mismatch" }),
    ]);
  });
});

function sequence(): SequenceArtifactV1 {
  return {
    version: "sequences.sequence.v1",
    concept: {
      summary: "Explain a selected control.",
      hierarchy: ["Canvas", "Tooltip"],
      motionGrammar: ["Tooltip enters"],
      rejectedChoices: [],
    },
    beats: [
      {
        id: "editor-beat",
        purpose: "Explain the selected control.",
        claims: [],
        entities: [
          { id: "editor-canvas", role: "Editor", parts: [] },
          { id: "tooltip", role: "Explanation", parts: [] },
        ],
        sourceIds: [],
        musicAnchors: [],
        proofTimes: [1],
        implementationFiles: ["index.html"],
      },
    ],
    overlapIntents: [
      {
        id: "tooltip-canvas",
        kind: "overlay",
        entities: ["tooltip", "editor-canvas"],
        timeRange: [0.5, 1.5],
        zOrder: ["editor-canvas", "tooltip"],
        mustRemainReadable: ["tooltip"],
        reason: "Tooltip explains the selected control.",
      },
    ],
    revision: null,
  };
}
