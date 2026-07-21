import { describe, expect, it } from "vitest";

import {
  AgentWorkflowReceiptV1Schema,
  RunReceiptV1Schema,
  TemporalEvidenceV1Schema,
  VisualAuditReportV1Schema,
} from "../../src/shared";

const jobId = `run_${"a".repeat(32)}`;

function legacyReceipt() {
  const now = "2026-07-17T12:00:00.000Z";
  return {
    version: "sequences.run-receipt.v1",
    jobId,
    projectId: "release-a",
    kind: "build",
    state: "applied",
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    baseCommit: "b".repeat(40),
    candidateRef: `candidate:${jobId}`,
    candidateCommit: "c".repeat(40),
    acceptedCommit: "c".repeat(40),
    patchSha256: "d".repeat(64),
    inversePatchSha256: "e".repeat(64),
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    codexCliVersion: "codex-cli 1.0.0",
    sanitizedArguments: [],
    allowedPaths: ["sequence.json"],
    changedFiles: ["sequence.json"],
    skillManifestDigest: null,
    skillsUsed: [],
    exitCode: 0,
    timedOut: false,
    cancelRequested: false,
    final: null,
    qa: null,
    qaRemediations: [],
    layoutRepairs: [],
    director: null,
    context: null,
    proofComparison: null,
    decision: null,
    error: null,
  } as const;
}

function visualAuditFinding() {
  return {
    id: "camera-landing",
    severity: "major",
    category: "camera",
    beatIds: ["product-proof"],
    entityIds: ["product-window"],
    frameIds: ["product-proof-hold"],
    timeRange: [10, 12] as [number, number],
    observation: "The camera lands before the product result becomes readable.",
    repairIntent: "Delay the settle and preserve a readable hold on the result.",
  } as const;
}

describe("agent workflow contracts", () => {
  it("parses legacy run receipts with inert workflow and audit defaults", () => {
    const receipt = RunReceiptV1Schema.parse(legacyReceipt());

    expect(receipt.agentWorkflow).toEqual({
      version: "sequences.agent-workflow.v1",
      mode: "legacy",
      componentSpecialist: false,
      turns: [],
      compositorThreadId: null,
      temporalEvidenceArtifact: null,
      visualAuditArtifact: null,
    });
    expect(receipt.visualAudit).toBeNull();
  });

  it("parses a balanced workflow with typed turn telemetry", () => {
    const workflow = AgentWorkflowReceiptV1Schema.parse({
      version: "sequences.agent-workflow.v1",
      mode: "balanced",
      componentSpecialist: true,
      compositorThreadId: "123e4567-e89b-42d3-a456-426614174000",
      temporalEvidenceArtifact: "visual-audit/evidence.json",
      visualAuditArtifact: "visual-audit/report.json",
      turns: [
        {
          version: "sequences.codex-turn.v1",
          operation: "creative_direction",
          role: "creative_director",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          threadId: "123e4567-e89b-42d3-a456-426614174001",
          resumed: false,
          artifactDirectory: "turns/creative-direction",
          cliVersion: "codex-cli 1.0.0",
          sanitizedArguments: ["--model", "gpt-5.6-sol"],
          durationMs: 1_500,
          usage: {
            inputTokens: 100,
            cachedInputTokens: 25,
            outputTokens: 40,
            reasoningOutputTokens: 10,
          },
          exitCode: 0,
          timedOut: false,
          cancelled: false,
        },
      ],
    });

    expect(workflow.mode).toBe("balanced");
    expect(workflow.turns[0]?.usage?.cachedInputTokens).toBe(25);
  });

  it("validates temporal evidence against the declared duration", () => {
    const evidence = {
      version: "sequences.temporal-evidence.v1",
      duration: 24,
      qaArtifact: "qa/attempt-1/qa.json",
      frames: [
        {
          id: "product-proof-hold",
          at: 12,
          judgment: "landed",
          beatId: "product-proof",
          transitionId: null,
          entityIds: ["product-window"],
          labels: ["proof", "camera hold"],
          artifact: "visual-audit/frames/product-proof-hold.png",
          sha256: "f".repeat(64),
        },
      ],
    } as const;

    expect(TemporalEvidenceV1Schema.parse(evidence).frames).toHaveLength(1);
    expect(
      TemporalEvidenceV1Schema.safeParse({
        ...evidence,
        frames: [{ ...evidence.frames[0], at: 25 }],
      }).success,
    ).toBe(false);
  });

  it("rejects reversed visual-audit time ranges", () => {
    const result = VisualAuditReportV1Schema.safeParse({
      version: "sequences.visual-audit.v1",
      evidenceArtifact: "visual-audit/evidence.json",
      verdict: "repair",
      summary: "One major camera issue remains.",
      findings: [{ ...visualAuditFinding(), timeRange: [12, 10] }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown workflow and nested audit fields", () => {
    expect(
      AgentWorkflowReceiptV1Schema.safeParse({
        version: "sequences.agent-workflow.v1",
        mode: "legacy",
        componentSpecialist: false,
        compositorThreadId: null,
        temporalEvidenceArtifact: null,
        visualAuditArtifact: null,
        unexpected: true,
      }).success,
    ).toBe(false);

    expect(
      VisualAuditReportV1Schema.safeParse({
        version: "sequences.visual-audit.v1",
        evidenceArtifact: "visual-audit/evidence.json",
        verdict: "repair",
        summary: "One issue remains.",
        findings: [{ ...visualAuditFinding(), unexpected: true }],
      }).success,
    ).toBe(false);
  });
});
