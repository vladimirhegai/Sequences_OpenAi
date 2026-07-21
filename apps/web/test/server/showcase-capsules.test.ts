import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SequenceArtifactV1Schema } from "../../src/shared";
import {
  selectShowcaseCapsules,
  SHOWCASE_CAPSULE_GUIDANCE,
} from "../../src/server/showcase-capsules";

describe("bounded Showcase capsule retrieval", () => {
  it("selects the native conversation example for streaming and panel reflow", () => {
    const selected = selectShowcaseCapsules(
      "Show an authentic ChatGPT conversation streaming a response, then open Sources and reflow into a side panel and Canvas.",
    );

    expect(selected).toHaveLength(2);
    expect(selected[0]?.id).toBe("chatgpt-native-story");
    expect(selected.map(({ id }) => id)).toContain("chatgpt-ad");
  });

  it("uses locked sequence audio cues to retrieve the typing and click reference", () => {
    const sequence = SequenceArtifactV1Schema.parse({
      version: "sequences.sequence.v1",
      format: { width: 1920, height: 1080, fps: 30, targetDuration: 8 },
      concept: {
        summary: "A confident product action becomes proof.",
        hierarchy: ["Action", "Consequence"],
        motionGrammar: ["The operated control visibly changes state."],
        rejectedChoices: [],
      },
      beats: [
        {
          id: "operate",
          start: 0,
          duration: 8,
          purpose: "Operate the product and reveal the result.",
          entities: [{ id: "generate-control", role: "Generate control", parts: [] }],
          proofTimes: [6],
          implementationFiles: ["compositions/02-compose.html"],
        },
      ],
      transitions: [],
      audio: {
        soundtrackId: "confident-commercial",
        cues: [
          { kind: "typing", startSec: 1, endSec: 2.5 },
          { kind: "mouse-click", atSec: 3 },
        ],
      },
    });

    const selected = selectShowcaseCapsules("Make a confident product story", sequence);
    expect(selected.length).toBeLessThanOrEqual(2);
    expect(selected[0]?.id).toBe("sequences-recommendation-ad");
  });

  it("selects the audio-led abstract example for semantic continuity", () => {
    const selected = selectShowcaseCapsules(
      "Create an audio-led abstract film with constant motion where one prompt seed morphs through every scene.",
    );

    expect(selected[0]?.id).toBe("sequences-abstract-ad");
    expect(selected.length).toBeLessThanOrEqual(2);
  });

  it("falls back deterministically to one general SaaS craft reference", () => {
    expect(selectShowcaseCapsules("Make something confident and blue").map(({ id }) => id)).toEqual(
      ["slack-ad"],
    );
    expect(SHOWCASE_CAPSULE_GUIDANCE).toContain("do not duplicate an entire film");
  });

  it("points only at small candidate-local references that exist in the pinned skill", async () => {
    const selected = [
      selectShowcaseCapsules("A Slack collaboration workspace story")[0]!,
      selectShowcaseCapsules("An OpenAI-like ChatGPT ad with a canonical knot")[0]!,
      selectShowcaseCapsules("A conversation with Sources, Canvas, and panel reflow")[0]!,
      selectShowcaseCapsules("Type into a field, click Generate, then interrupt with a glitch")[0]!,
      selectShowcaseCapsules("An audio-led abstract semantic morph")[0]!,
    ];

    expect(new Set(selected.map(({ id }) => id)).size).toBe(5);
    const paths = selected.flatMap(({ reference, contactSheet, sourceFiles }) => [
      reference,
      contactSheet,
      ...sourceFiles,
    ]);
    expect(paths.every((path) => path.startsWith(".agents/skills/sequences-saas-launch/"))).toBe(
      true,
    );
    expect(paths.every((path) => !path.endsWith(".mp4"))).toBe(true);
    for (const path of paths) {
      expect((await stat(join(process.cwd(), path))).size).toBeGreaterThan(0);
    }
    for (const capsule of selected) {
      const capsulePath = join(process.cwd(), capsule.reference);
      const markdown = await readFile(capsulePath, "utf8");
      for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
        expect((await stat(resolve(dirname(capsulePath), match[1]!))).size).toBeGreaterThan(0);
      }
    }
  });
});
