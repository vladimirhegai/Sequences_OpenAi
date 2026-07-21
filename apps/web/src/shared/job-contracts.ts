import { z } from "zod";
import { LayoutClusterV1Schema, LayoutRectV1Schema } from "./layout-contracts";
import { RevisionScopeV1Schema } from "./sequence-contracts";

export const PROJECT_ID = "release-a" as const;
export const MODEL_ID = "gpt-5.6-luna" as const;
export const REASONING_EFFORT = "high" as const;

/**
 * The default author is GPT-5.6 Luna at high reasoning. The host may route a
 * run to another Codex model (for example gpt-5.6-sol or gpt-5.6-terra probes)
 * through configuration; the receipt records the model actually used.
 */
export const CodexModelIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,63}$/, "Codex model IDs are lowercase slug-like identifiers");
export const ReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

export type CodexModelId = z.infer<typeof CodexModelIdSchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ProjectIdSchema = z.literal(PROJECT_ID);
export const GitCommitSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
export const JobIdSchema = z.string().regex(/^run_[0-9a-f]{32}$/);
export const JobKindSchema = z.enum(["plan", "build", "revision"]);
export const JobStateSchema = z.enum([
  "queued",
  "preparing",
  "authoring",
  "verifying",
  "review_ready",
  "applying",
  "applied",
  "rejected",
  "stale",
  "failed",
  "timed_out",
  "cancelled",
]);

export type JobKind = z.infer<typeof JobKindSchema>;
export type JobState = z.infer<typeof JobStateSchema>;

export const TERMINAL_JOB_STATES = new Set<JobState>([
  "applied",
  "rejected",
  "stale",
  "failed",
  "timed_out",
  "cancelled",
]);

export const MUTABLE_JOB_STATES = new Set<JobState>([
  "queued",
  "preparing",
  "authoring",
  "verifying",
  "applying",
]);

const RelativeScopePathSchema = z
  .string()
  .min(1)
  .max(180)
  .refine((value) => !value.includes("\\") && !value.startsWith("/") && !value.includes("\0"), {
    message: "Paths must be project-relative POSIX paths",
  })
  .refine((value) => !value.split("/").some((part) => part === ".." || part === "."), {
    message: "Paths cannot contain dot traversal segments",
  });

/**
 * The Phase 1 HTTP boundary accepts one operation: start a fresh video build.
 * Broader execution fields remain represented below only while the internal
 * job runner still contains quarantined plan/revision code paths.
 */
export const StartJobRequestV1Schema = z
  .object({
    version: z.literal("sequences.start-job.v1"),
    kind: z.literal("build"),
    prompt: z.string().trim().min(1).max(16_000),
    baseCommit: GitCommitSchema.optional(),
    scopePaths: z.array(RelativeScopePathSchema).max(16).optional(),
    imagePaths: z.array(RelativeScopePathSchema).max(4).optional(),
    directorMode: z.literal("reset").default("reset"),
  })
  .strict();

export type PublicStartJobRequestV1 = z.infer<typeof StartJobRequestV1Schema>;

const InternalJobExecutionRequestV1Schema = z
  .object({
    version: z.literal("sequences.start-job.v1"),
    kind: JobKindSchema,
    prompt: z.string().trim().min(1).max(16_000),
    baseCommit: GitCommitSchema.optional(),
    scopePaths: z.array(RelativeScopePathSchema).max(16).optional(),
    imagePaths: z.array(RelativeScopePathSchema).max(4).optional(),
    directorMode: z.enum(["continue", "reset"]),
    revision: RevisionScopeV1Schema.optional(),
  })
  .strict();

/** @internal Compatibility shape for the quarantined JobManager execution paths. */
export type StartJobRequestV1 = z.infer<typeof InternalJobExecutionRequestV1Schema>;

export const JobActionRequestV1Schema = z
  .object({
    version: z.literal("sequences.job-action.v1"),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export const CodexFinalV1Schema = z
  .object({
    version: z.literal("sequences.codex-final.v1"),
    intent: z.string().min(1).max(2_000),
    artifacts: z.array(RelativeScopePathSchema).max(100),
    skillsUsed: z.array(z.string().min(1).max(120)).max(20),
    limitations: z.array(z.string().min(1).max(1_000)).max(20),
    proofTimes: z.array(z.number().finite().min(0).max(3_600)).max(30),
  })
  .strict();

export type CodexFinalV1 = z.infer<typeof CodexFinalV1Schema>;

export const QaCommandResultV1Schema = z
  .object({
    command: z.enum(["lint", "check"]),
    ok: z.boolean(),
    exitCode: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative().optional(),
    warningCount: z.number().int().nonnegative().optional(),
    artifact: z.string().min(1),
    error: z.string().max(4_000).optional(),
  })
  .strict();

export const QaFindingV1Schema = z
  .object({
    command: z.enum(["lint", "check"]),
    category: z.string().min(1).max(120),
    code: z.string().min(1).max(160),
    severity: z.enum(["error", "warning", "info"]),
    sourceFile: z.string().min(1).max(300).nullable(),
    selector: z.string().min(1).max(1_000).nullable(),
    times: z.array(z.number().finite().nonnegative()).max(30),
    message: z.string().min(1).max(2_000),
    text: z.string().max(2_000).nullable().optional(),
    fixHint: z.string().min(1).max(2_000).nullable(),
    identity: z
      .object({ hfId: z.string().min(1).max(300).nullable() })
      .strict()
      .optional(),
    observationCount: z.number().int().positive().max(10_000).optional(),
    geometry: z
      .object({
        bbox: LayoutRectV1Schema.nullable(),
        relatedSelector: z.string().min(1).max(1_000).nullable(),
        relatedBbox: LayoutRectV1Schema.nullable(),
        coveredFraction: z.number().finite().min(0).max(1).nullable(),
        firstSeen: z.number().finite().nonnegative().max(3_600).nullable(),
        lastSeen: z.number().finite().nonnegative().max(3_600).nullable(),
        occurrences: z.number().int().positive().max(10_000),
      })
      .strict()
      .optional(),
    contrast: z
      .object({
        samples: z
          .array(
            z
              .object({
                foreground: z.string().min(1).max(80),
                background: z.string().min(1).max(80),
                ratio: z.number().finite().positive(),
                requiredRatio: z.number().finite().positive(),
                suggestedColor: z.string().min(1).max(80).nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(30),
      })
      .strict()
      .optional(),
    artifact: z.string().min(1).max(300),
  })
  .strict();

export type QaFindingV1 = z.infer<typeof QaFindingV1Schema>;

const QaSummaryV1Schema = z
  .object({
    errorCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
    infoCount: z.number().int().nonnegative(),
  })
  .strict();

const EmptyQaSummaryV1 = { errorCount: 0, warningCount: 0, infoCount: 0 } as const;
export const MAX_QA_RECEIPT_FINDINGS = 1_000;

export const QaReceiptV1Schema = z
  .object({
    version: z.literal("sequences.qa-receipt.v1"),
    hyperframesVersion: z.literal("0.7.56"),
    ok: z.boolean(),
    commands: z.array(QaCommandResultV1Schema).min(1).max(2),
    summary: QaSummaryV1Schema.default(EmptyQaSummaryV1),
    findings: z.array(QaFindingV1Schema).max(MAX_QA_RECEIPT_FINDINGS).default([]),
    layoutClusters: z.array(LayoutClusterV1Schema).max(30).optional(),
    adjudicated: z.boolean().optional(),
  })
  .strict();

export type QaReceiptV1 = z.infer<typeof QaReceiptV1Schema>;

const ContrastRemediationV1Schema = z
  .object({
    version: z.literal("sequences.qa-remediation.v1"),
    category: z.literal("contrast"),
    fixerVersion: z.literal("sequences.contrast-fixer.v1"),
    pass: z.number().int().positive().max(10),
    inputArtifact: z.string().min(1).max(300),
    outputArtifact: z.string().min(1).max(300),
    repaired: z
      .array(
        z
          .object({
            sourceFile: RelativeScopePathSchema,
            selector: z.string().min(1).max(1_000),
            strategy: z.enum(["foreground", "contrast_plate"]),
            foregroundBefore: z.string().min(1).max(80),
            foregroundAfter: z.string().min(1).max(80),
            plateColor: z.string().min(1).max(80).nullable(),
            backgroundColors: z.array(z.string().min(1).max(80)).min(1).max(30),
            requiredRatio: z.number().finite().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

const TweenOverlapRemediationV1Schema = z
  .object({
    version: z.literal("sequences.qa-remediation.v1"),
    category: z.literal("tween_overlap"),
    fixerVersion: z.literal("sequences.tween-overlap-fixer.v1"),
    pass: z.number().int().positive().max(6),
    inputArtifact: z.string().min(1).max(300),
    outputArtifact: z.string().min(1).max(300),
    repaired: z
      .array(
        z
          .object({
            sourceFile: RelativeScopePathSchema,
            selector: z.string().min(1).max(1_000),
            property: z.string().min(1).max(80),
            at: z.number().finite().nonnegative().max(3_600),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

/**
 * Up to two bounded same-thread author turns for residual non-layout failures
 * that have no deterministic fixer. They are creative repairs, so each pass
 * is recorded with the director thread and adopted only under transactional
 * strict-improvement rules after a full HyperFrames re-verification.
 */
const AuthorPolishRemediationV1Schema = z
  .object({
    version: z.literal("sequences.qa-remediation.v1"),
    category: z.literal("author_polish"),
    fixerVersion: z.literal("sequences.author-polish.v1"),
    pass: z.number().int().positive().max(2),
    inputArtifact: z.string().min(1).max(300),
    outputArtifact: z.string().min(1).max(300),
    threadId: z.string().uuid(),
    // Empty on older receipts and when the verifier produced no snapshots.
    // New polish turns record the exact read-only pixels attached to Codex.
    evidenceImages: z.array(RelativeScopePathSchema).max(3).default([]),
    repaired: z
      .array(z.object({ sourceFile: RelativeScopePathSchema }).strict())
      .min(1)
      .max(100),
  })
  .strict();

export const QaRemediationV1Schema = z.discriminatedUnion("category", [
  ContrastRemediationV1Schema,
  TweenOverlapRemediationV1Schema,
  AuthorPolishRemediationV1Schema,
]);

export type QaRemediationV1 = z.infer<typeof QaRemediationV1Schema>;
export type ContrastRemediationV1 = z.infer<typeof ContrastRemediationV1Schema>;
export type TweenOverlapRemediationV1 = z.infer<typeof TweenOverlapRemediationV1Schema>;
export type AuthorPolishRemediationV1 = z.infer<typeof AuthorPolishRemediationV1Schema>;

export const DirectorRunV1Schema = z
  .object({
    mode: z.enum(["continue", "reset"]),
    generation: z.number().int().positive(),
    threadId: z.string().uuid(),
    resumed: z.boolean(),
    parentRunId: JobIdSchema.nullable(),
  })
  .strict();

export const ContextReceiptV1Schema = z
  .object({
    version: z.literal("sequences.context-receipt.v1"),
    cacheKey: z.string().regex(/^[0-9a-f]{64}$/),
    cacheHit: z.boolean(),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1_024),
    calls: z
      .array(
        z.enum([
          "list_skills",
          "select_capabilities",
          "select_showcase_capsules",
          "inspect_sequence",
          "read_qa_findings",
          "inspect_layout",
        ]),
      )
      .max(6),
    artifact: z.string().min(1).max(300),
    showcaseCapsules: z
      .array(
        z.enum([
          "slack-ad",
          "chatgpt-ad",
          "chatgpt-native-story",
          "sequences-recommendation-ad",
          "sequences-abstract-ad",
        ]),
      )
      .max(2)
      .default([]),
  })
  .strict();

export const ProofComparisonV1Schema = z
  .object({
    version: z.literal("sequences.proof-comparison.v1"),
    ok: z.boolean(),
    artifact: z.string().min(1).max(300),
    frames: z
      .array(
        z
          .object({
            beatId: z.string().min(1).max(120),
            time: z.number().finite().nonnegative(),
            baseSha256: z.string().regex(/^[0-9a-f]{64}$/),
            candidateSha256: z.string().regex(/^[0-9a-f]{64}$/),
            identical: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

export const LayoutRepairAttemptV1Schema = z
  .object({
    version: z.literal("sequences.layout-repair-attempt.v1"),
    attempt: z.number().int().min(1).max(3),
    clusterIds: z
      .array(z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/))
      .min(1)
      .max(8),
    threadId: z.string().uuid(),
    resumed: z.literal(true),
    inputQaArtifact: RelativeScopePathSchema,
    outputQaArtifact: RelativeScopePathSchema.nullable(),
    contextArtifact: RelativeScopePathSchema,
    evidenceImages: z.array(RelativeScopePathSchema).min(1).max(4),
    allowedPaths: z.array(RelativeScopePathSchema).min(1).max(16),
    changedFiles: z.array(RelativeScopePathSchema).max(30),
    adopted: z.boolean(),
    beforeUnresolvedClusters: z.number().int().nonnegative().max(30),
    afterUnresolvedClusters: z.number().int().nonnegative().max(30).nullable(),
    proofComparison: ProofComparisonV1Schema.nullable(),
    final: CodexFinalV1Schema.nullable(),
    error: z.string().min(1).max(4_000).nullable(),
  })
  .strict();

export type LayoutRepairAttemptV1 = z.infer<typeof LayoutRepairAttemptV1Schema>;

const AgentArtifactIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/)
  .max(120);

export const AgentWorkflowModeSchema = z.enum(["legacy", "balanced"]);
export const AgentRoleSchema = z.enum([
  "legacy_director",
  "creative_director",
  "component_architect",
  "compositor",
  "visual_auditor",
]);
export const CodexOperationSchema = z.enum([
  "author",
  "author_recovery",
  "creative_direction",
  "component_architecture",
  "contract_repair",
  "layout_repair",
  "qa_repair",
  "visual_audit",
  "audit_polish",
]);

export type AgentWorkflowMode = z.infer<typeof AgentWorkflowModeSchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type CodexOperation = z.infer<typeof CodexOperationSchema>;

export const CodexTokenUsageV1Schema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  })
  .strict();

export type CodexTokenUsageV1 = z.infer<typeof CodexTokenUsageV1Schema>;

export const CodexTurnReceiptV1Schema = z
  .object({
    version: z.literal("sequences.codex-turn.v1"),
    operation: CodexOperationSchema,
    role: AgentRoleSchema,
    model: CodexModelIdSchema,
    reasoningEffort: ReasoningEffortSchema,
    threadId: z.string().uuid().nullable(),
    resumed: z.boolean(),
    artifactDirectory: z.string().min(1).max(300).nullable(),
    cliVersion: z.string().min(1).max(200),
    sanitizedArguments: z.array(z.string().max(500)).max(80),
    durationMs: z.number().int().nonnegative(),
    usage: CodexTokenUsageV1Schema.nullable(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
  })
  .strict();

export type CodexTurnReceiptV1 = z.infer<typeof CodexTurnReceiptV1Schema>;

export const AgentWorkflowReceiptV1Schema = z
  .object({
    version: z.literal("sequences.agent-workflow.v1"),
    mode: AgentWorkflowModeSchema,
    componentSpecialist: z.boolean(),
    turns: z.array(CodexTurnReceiptV1Schema).max(20).default([]),
    compositorThreadId: z.string().uuid().nullable(),
    temporalEvidenceArtifact: RelativeScopePathSchema.nullable(),
    visualAuditArtifact: RelativeScopePathSchema.nullable(),
  })
  .strict();

export type AgentWorkflowReceiptV1 = z.infer<typeof AgentWorkflowReceiptV1Schema>;

const TemporalEvidenceFrameV1Schema = z
  .object({
    id: AgentArtifactIdSchema,
    at: z.number().finite().nonnegative().max(3_600),
    judgment: z.enum(["transit", "landed"]),
    beatId: AgentArtifactIdSchema.nullable(),
    transitionId: AgentArtifactIdSchema.nullable(),
    entityIds: z.array(AgentArtifactIdSchema).max(20),
    labels: z.array(z.string().trim().min(1).max(300)).max(20),
    artifact: RelativeScopePathSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const TemporalEvidenceV1Schema = z
  .object({
    version: z.literal("sequences.temporal-evidence.v1"),
    duration: z.number().finite().positive().max(3_600),
    qaArtifact: RelativeScopePathSchema,
    frames: z.array(TemporalEvidenceFrameV1Schema).max(40),
  })
  .strict()
  .superRefine((evidence, context) => {
    for (const [index, frame] of evidence.frames.entries()) {
      if (frame.at > evidence.duration) {
        context.addIssue({
          code: "custom",
          message: `Temporal evidence frame ${frame.id} exceeds the evidence duration`,
          path: ["frames", index, "at"],
        });
      }
    }
  });

export type TemporalEvidenceV1 = z.infer<typeof TemporalEvidenceV1Schema>;

const VisualAuditFindingV1Schema = z
  .object({
    id: AgentArtifactIdSchema,
    severity: z.enum(["major", "minor"]),
    category: z.enum([
      "story",
      "brand",
      "composition",
      "component",
      "placement",
      "camera",
      "motion",
      "transition",
      "legibility",
      "final-hold",
    ]),
    beatIds: z.array(AgentArtifactIdSchema).max(8),
    entityIds: z.array(AgentArtifactIdSchema).max(20),
    frameIds: z.array(AgentArtifactIdSchema).max(40),
    timeRange: z.tuple([
      z.number().finite().nonnegative().max(3_600),
      z.number().finite().nonnegative().max(3_600),
    ]),
    observation: z.string().trim().min(1).max(2_000),
    repairIntent: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.timeRange[1] < finding.timeRange[0]) {
      context.addIssue({
        code: "custom",
        message: "Visual audit time range must end at or after it starts",
        path: ["timeRange"],
      });
    }
  });

export const VisualAuditReportV1Schema = z
  .object({
    version: z.literal("sequences.visual-audit.v1"),
    evidenceArtifact: RelativeScopePathSchema,
    verdict: z.enum(["pass", "repair"]),
    summary: z.string().trim().min(1).max(2_000),
    findings: z.array(VisualAuditFindingV1Schema).max(8),
  })
  .strict();

export type VisualAuditReportV1 = z.infer<typeof VisualAuditReportV1Schema>;

export const RunErrorV1Schema = z
  .object({
    code: z.string().regex(/^[a-z0-9_]+$/),
    message: z.string().min(1).max(4_000),
    owner: z.enum(["server", "codex", "git", "hyperframes", "policy"]),
  })
  .strict();

export const RunReceiptV1Schema = z
  .object({
    version: z.literal("sequences.run-receipt.v1"),
    jobId: JobIdSchema,
    projectId: ProjectIdSchema,
    kind: JobKindSchema,
    state: JobStateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    baseCommit: GitCommitSchema,
    candidateRef: z.string().regex(/^candidate:run_[0-9a-f]{32}$/),
    candidateCommit: GitCommitSchema.nullable(),
    acceptedCommit: GitCommitSchema.nullable(),
    patchSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    inversePatchSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    model: CodexModelIdSchema,
    reasoningEffort: ReasoningEffortSchema,
    codexCliVersion: z.string().min(1).max(200).nullable(),
    sanitizedArguments: z.array(z.string().max(500)).max(80),
    allowedPaths: z.array(RelativeScopePathSchema).max(100),
    changedFiles: z.array(RelativeScopePathSchema).max(1_000),
    skillManifestDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    skillsUsed: z.array(z.string().min(1).max(120)).max(20),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    cancelRequested: z.boolean(),
    final: CodexFinalV1Schema.nullable(),
    qa: QaReceiptV1Schema.nullable(),
    qaRemediations: z.array(QaRemediationV1Schema).max(12).default([]),
    layoutRepairs: z.array(LayoutRepairAttemptV1Schema).max(3).default([]),
    director: DirectorRunV1Schema.nullable().default(null),
    context: ContextReceiptV1Schema.nullable().default(null),
    proofComparison: ProofComparisonV1Schema.nullable().default(null),
    agentWorkflow: AgentWorkflowReceiptV1Schema.default({
      version: "sequences.agent-workflow.v1",
      mode: "legacy",
      componentSpecialist: false,
      turns: [],
      compositorThreadId: null,
      temporalEvidenceArtifact: null,
      visualAuditArtifact: null,
    }),
    visualAudit: VisualAuditReportV1Schema.nullable().default(null),
    decision: z
      .object({
        action: z.enum(["applied", "rejected"]),
        at: z.string().datetime(),
        reason: z.string().max(500).nullable(),
      })
      .strict()
      .nullable(),
    error: RunErrorV1Schema.nullable(),
  })
  .strict();

export type RunReceiptV1 = z.infer<typeof RunReceiptV1Schema>;

export const JobEventV1Schema = z
  .object({
    version: z.literal("sequences.job-event.v1"),
    sequence: z.number().int().positive(),
    jobId: JobIdSchema,
    projectId: ProjectIdSchema,
    at: z.string().datetime(),
    state: JobStateSchema,
    stage: z.enum([
      "queued",
      "preparing",
      "authoring",
      "verifying",
      "review",
      "decision",
      "complete",
      "error",
    ]),
    message: z.string().min(1).max(1_000),
    currentFile: RelativeScopePathSchema.optional(),
    tool: z
      .string()
      .regex(/^[a-z0-9_.-]+$/)
      .optional(),
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();

export type JobEventV1 = z.infer<typeof JobEventV1Schema>;

export const JobResponseV1Schema = z
  .object({
    version: z.literal("sequences.job-response.v1"),
    receipt: RunReceiptV1Schema,
    eventsUrl: z.string().min(1),
    candidateUrl: z.string().min(1),
  })
  .strict();
