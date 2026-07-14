import { z } from "zod";

export const PROJECT_ID = "release-a" as const;
export const MODEL_ID = "gpt-5.6-luna" as const;
export const REASONING_EFFORT = "high" as const;

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

export const StartJobRequestV1Schema = z
  .object({
    version: z.literal("sequences.start-job.v1"),
    kind: JobKindSchema,
    prompt: z.string().trim().min(1).max(16_000),
    baseCommit: GitCommitSchema.optional(),
    scopePaths: z.array(RelativeScopePathSchema).max(16).optional(),
    imagePaths: z.array(RelativeScopePathSchema).max(4).optional(),
  })
  .strict();

export type StartJobRequestV1 = z.infer<typeof StartJobRequestV1Schema>;

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

export const QaReceiptV1Schema = z
  .object({
    version: z.literal("sequences.qa-receipt.v1"),
    hyperframesVersion: z.literal("0.7.56"),
    ok: z.boolean(),
    commands: z.array(QaCommandResultV1Schema).min(1).max(2),
  })
  .strict();

export type QaReceiptV1 = z.infer<typeof QaReceiptV1Schema>;

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
    patchSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    model: z.literal(MODEL_ID),
    reasoningEffort: z.literal(REASONING_EFFORT),
    codexCliVersion: z.string().min(1).max(200).nullable(),
    sanitizedArguments: z.array(z.string().max(500)).max(80),
    allowedPaths: z.array(RelativeScopePathSchema).max(100),
    changedFiles: z.array(RelativeScopePathSchema).max(1_000),
    skillManifestDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    skillsUsed: z.array(z.string().min(1).max(120)).max(20),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    cancelRequested: z.boolean(),
    final: CodexFinalV1Schema.nullable(),
    qa: QaReceiptV1Schema.nullable(),
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
    tool: z.string().regex(/^[a-z0-9_.-]+$/).optional(),
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
