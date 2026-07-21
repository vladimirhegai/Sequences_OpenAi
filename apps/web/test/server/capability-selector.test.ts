import { describe, expect, it } from "vitest";
import { SequenceArtifactV1Schema } from "../../src/shared";
import { selectAuthorCapabilities } from "../../src/server/capability-selector";

describe("bounded Luna capability retrieval", () => {
  it("selects a small prompt-relevant capsule without recurring decorative defaults", () => {
    const selected = selectAuthorCapabilities(
      "Create a SaaS product launch with a cursor action, identity-preserving match cut, and camera zoom.",
    );
    const ids = selected.map((capability) => capability.id);

    expect(selected.length).toBeLessThanOrEqual(6);
    expect(ids).toContain("camera-targeting");
    expect(ids).toContain("identity-morph");
    expect(ids).toContain("product-cursor-action");
    expect(ids).not.toContain("metric-proof");
    expect(selected.every((capability) => capability.reference.endsWith(".md"))).toBe(true);
    expect(selected.find(({ id }) => id === "product-cursor-action")?.reference).toBe(
      "rules/cursor-click-ripple.md",
    );
    expect(selected.find(({ id }) => id === "product-cursor-action")?.candidateReferences).toEqual([
      "compositions/_primitives/pointer-action.js",
      "compositions/_primitives/pointer-action.example.html",
    ]);
    expect(
      selected
        .find(({ id }) => id === "product-cursor-action")
        ?.constraints.some((constraint) => constraint.includes("display:none")),
    ).toBe(true);
  });

  it("routes product typing and click cues to candidate-local primitives", () => {
    const selected = selectAuthorCapabilities(
      "Type into the product prompt field, then click Generate and show the result.",
    );

    expect(selected.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["product-typewriter", "product-cursor-action"]),
    );
    expect(selected.find(({ id }) => id === "product-typewriter")?.candidateReferences).toEqual([
      "compositions/_primitives/typewriter.js",
      "compositions/_primitives/typewriter.example.html",
    ]);
    expect(selected.find(({ id }) => id === "product-cursor-action")?.candidateReferences).toEqual([
      "compositions/_primitives/pointer-action.js",
      "compositions/_primitives/pointer-action.example.html",
    ]);
  });

  it("retrieves camera, morph, and pointer rules from the locked sequence", () => {
    const sequence = SequenceArtifactV1Schema.parse({
      version: "sequences.sequence.v1",
      format: { width: 1920, height: 1080, fps: 30, targetDuration: 8 },
      concept: {
        summary: "An abstract launch story.",
        hierarchy: ["Cause", "Effect"],
        motionGrammar: ["An operated pointer presses the approval control."],
        rejectedChoices: [],
      },
      beats: [
        {
          id: "action",
          start: 0,
          duration: 4,
          purpose: "Operate the product.",
          entities: [{ id: "control", role: "Approval control", parts: [] }],
          proofTimes: [2],
          implementationFiles: ["compositions/02-compose.html"],
          camera: {
            owner: "dom-world",
            targetEntityId: "control",
            startPose: { x: 0, y: 0, scale: 1 },
            endPose: { x: 10, y: -10, scale: 1.2 },
            arrival: 1,
            settle: 1.4,
            hold: 2,
          },
        },
        {
          id: "result",
          start: 4,
          duration: 4,
          purpose: "Show the result.",
          entities: [{ id: "result-badge", role: "Result badge", parts: [] }],
          proofTimes: [6],
          implementationFiles: ["compositions/02-compose.html"],
        },
      ],
      transitions: [
        {
          id: "control-to-result",
          fromBeatId: "action",
          toBeatId: "result",
          kind: "morph",
          at: 4,
          duration: 0.6,
          outgoingEntityId: "control",
          incomingEntityId: "result-badge",
        },
      ],
    });

    const ids = selectAuthorCapabilities("Make something confident and blue", sequence).map(
      ({ id }) => id,
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        "camera-targeting",
        "multi-phase-camera",
        "identity-morph",
        "product-cursor-action",
      ]),
    );
    expect(ids).not.toContain("collaboration-network");
  });

  it("keeps only the launch-wide product and boundary guidance for an abstract brief", () => {
    expect(
      selectAuthorCapabilities("Make something confident and blue").map(({ id }) => id),
    ).toEqual(["intentional-boundaries", "product-frame-density"]);
  });
});
