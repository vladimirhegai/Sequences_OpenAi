import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SequenceArtifactV1 } from "../../src/shared";
import { AuthorContextGateway } from "../../src/server/author-context";
import { createServerConfig } from "../../src/server/config";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function gateway(tempRoot: string): AuthorContextGateway {
  return new AuthorContextGateway(
    createServerConfig({ workspaceRoot: tempRoot, runsRoot: join(tempRoot, "runs") }),
  );
}

const SKILLS = { skills: [{ id: "hyperframes", purpose: "Routing" }] };

function fatSequence(): SequenceArtifactV1 {
  const beats = Array.from({ length: 24 }, (_value, index) => ({
    id: `beat-${index}`,
    role: "product-proof",
    start: index,
    duration: 1,
    purpose: "P".repeat(900),
    claims: [{ id: `claim-${index}`, text: "C".repeat(800), sourceIds: [] }],
    entities: [{ id: `entity-${index}`, role: "R".repeat(280), parts: [] }],
    sourceIds: [],
    musicAnchors: [],
    proofTimes: [index + 0.5],
    implementationFiles: ["compositions/02-compose.html"],
    // Passthrough creative metadata that inflates the artifact.
    directorNotes: "N".repeat(1_200),
  }));
  return {
    version: "sequences.sequence.v1",
    format: { width: 1920, height: 1080, fps: 30, targetDuration: 24 },
    concept: {
      summary: "S".repeat(1_800),
      hierarchy: Array.from({ length: 18 }, () => "H".repeat(400)),
      motionGrammar: Array.from({ length: 18 }, () => "M".repeat(400)),
      rejectedChoices: [],
    },
    beats,
    transitions: [],
    overlapIntents: [],
    revision: null,
  } as unknown as SequenceArtifactV1;
}

function fatFindings(): unknown[] {
  return Array.from({ length: 30 }, (_value, index) => ({
    command: "check",
    category: "layout",
    code: "content_overlap",
    severity: "error",
    sourceFile: "compositions/02-compose.html",
    selector: `#target-${index}`,
    times: [index],
    message: "M".repeat(1_500),
    fixHint: "F".repeat(1_000),
    geometry: { boxes: Array.from({ length: 20 }, () => ({ x: 1, y: 2, w: 3, h: 4 })) },
  }));
}

describe("author context gateway", () => {
  it("fits an oversized repair context inside the byte budget by trimming deterministically", async () => {
    // Specimen class from run_9623938a: a rich authored sequence plus a large
    // finding set plus an inspection packet overflowed 64 KiB during repair
    // context preparation and killed an otherwise repairable run.
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-context-trim-"));
    roots.push(tempRoot);
    const contexts = gateway(tempRoot);

    const { context, receipt } = await contexts.prepare({
      runRoot: tempRoot,
      acceptedCommit: "a".repeat(40),
      skills: SKILLS as never,
      prompt: "Launch film",
      sequence: fatSequence(),
      revisionScope: null,
      qaFindings: fatFindings(),
      layoutInspection: {
        version: "sequences.layout-inspection.v1",
        filler: "X".repeat(40_000),
      } as never,
    });

    expect(receipt.bytes).toBeLessThanOrEqual(64 * 1_024);
    // Trimming precedence: the inspection packet goes first, findings are
    // compacted, and the sequence keeps every beat but only contract fields.
    expect(context.layoutInspection).toBeNull();
    expect(context.qaFindings.length).toBeLessThanOrEqual(12);
    const firstFinding = context.qaFindings[0] as Record<string, unknown>;
    expect(String(firstFinding.message)).toHaveLength(300);
    expect(firstFinding.geometry).toBeUndefined();
    expect(context.sequence?.beats).toHaveLength(24);
    const firstBeat = context.sequence?.beats[0] as Record<string, unknown>;
    expect(firstBeat.directorNotes).toBeUndefined();
    expect(String(firstBeat.purpose)).toHaveLength(200);
    const artifact = await readFile(join(tempRoot, "context.json"), "utf8");
    expect(Buffer.byteLength(artifact, "utf8")).toBeLessThanOrEqual(64 * 1_024);
  });

  it("leaves a small context untouched", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-context-small-"));
    roots.push(tempRoot);
    const contexts = gateway(tempRoot);

    const { context, receipt } = await contexts.prepare({
      runRoot: tempRoot,
      acceptedCommit: "b".repeat(40),
      skills: SKILLS as never,
      prompt: "Launch film",
      sequence: null,
      revisionScope: null,
      qaFindings: [{ code: "content_overlap", message: "Small", geometry: { keep: true } }],
      layoutInspection: null,
    });

    expect(receipt.bytes).toBeLessThanOrEqual(64 * 1_024);
    const finding = context.qaFindings[0] as Record<string, unknown>;
    // No trimming pressure: findings keep their full shape.
    expect(finding.geometry).toEqual({ keep: true });
    expect(context.showcaseCapsules).toMatchObject({
      instruction: expect.stringContaining("do not duplicate an entire film"),
      selected: [{ id: "slack-ad" }],
    });
    expect(receipt.showcaseCapsules).toEqual(["slack-ad"]);
    expect(receipt.calls).toContain("select_showcase_capsules");
  });

  it("passes candidate-local interaction primitives and the matching Showcase receipt evidence", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-context-interaction-"));
    roots.push(tempRoot);
    const contexts = gateway(tempRoot);

    const { context, receipt } = await contexts.prepare({
      runRoot: tempRoot,
      acceptedCommit: "c".repeat(40),
      skills: SKILLS as never,
      prompt: "Type into the product prompt, then click Generate and show the result immediately.",
      sequence: null,
      revisionScope: null,
    });

    expect(
      context.capabilities.find(({ id }) => id === "product-typewriter")?.candidateReferences,
    ).toEqual([
      "compositions/_primitives/typewriter.js",
      "compositions/_primitives/typewriter.example.html",
    ]);
    expect(
      context.capabilities.find(({ id }) => id === "product-cursor-action")?.candidateReferences,
    ).toEqual([
      "compositions/_primitives/pointer-action.js",
      "compositions/_primitives/pointer-action.example.html",
    ]);
    expect(context.showcaseCapsules.selected[0]?.id).toBe("sequences-recommendation-ad");
    expect(receipt.showcaseCapsules).toContain("sequences-recommendation-ad");
  });
});
