import { z } from "zod";
import { GitCommitSchema, JobIdSchema, JobStateSchema, ProjectIdSchema } from "./job-contracts";

export const ApiErrorV1Schema = z
  .object({
    version: z.literal("sequences.error.v1"),
    error: z.object({
      code: z.string().regex(/^[a-z0-9_]+$/),
      message: z.string().min(1).max(2_000),
      requestId: z.string().min(1).max(100),
      details: z.array(z.string().max(500)).max(20).optional(),
    }),
  })
  .strict();

export type ApiErrorV1 = z.infer<typeof ApiErrorV1Schema>;

export const CreateSessionRequestV1Schema = z
  .object({
    version: z.literal("sequences.create-session.v1"),
    bootToken: z.string().min(32).max(256),
  })
  .strict();

export const SessionResponseV1Schema = z
  .object({
    version: z.literal("sequences.session.v1"),
    csrfToken: z.string().min(32).max(256),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const ProjectSummaryV1Schema = z
  .object({
    version: z.literal("sequences.project-summary.v1"),
    id: ProjectIdSchema,
    title: z.string().min(1).max(200),
    acceptedCommit: GitCommitSchema,
    acceptedUrl: z.string().min(1),
    sampleUrl: z.string().min(1),
    files: z.array(z.string().min(1).max(300)).max(5_000),
    jobs: z
      .array(
        z
          .object({
            id: JobIdSchema,
            state: JobStateSchema,
            kind: z.enum(["plan", "build", "revision"]),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const ProjectsResponseV1Schema = z
  .object({
    version: z.literal("sequences.projects.v1"),
    projects: z.array(ProjectSummaryV1Schema).length(1),
  })
  .strict();

const SkillCapabilityV1Schema = z
  .object({
    id: z.string().min(1).max(120),
    hash: z.string().regex(/^[0-9a-f]{16}$/),
    files: z.number().int().positive(),
  })
  .strict();

const RegistryCapabilityV1Schema = z
  .object({
    id: z.string().min(1).max(160),
    type: z.string().min(1).max(120),
  })
  .strict();

export const CapabilitiesResponseV1Schema = z
  .object({
    version: z.literal("sequences.capabilities.v1"),
    hyperframesVersion: z.literal("0.7.56"),
    available: z.boolean(),
    manifestDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    manifestSource: z.string().max(300).nullable(),
    skills: z.array(SkillCapabilityV1Schema).max(100),
    registry: z.array(RegistryCapabilityV1Schema).max(1_000),
    qaCommands: z.array(z.enum(["lint", "check", "keyframes", "snapshot", "render"])),
    unavailableReason: z.string().max(1_000).nullable(),
  })
  .strict();

export type CapabilitiesResponseV1 = z.infer<typeof CapabilitiesResponseV1Schema>;

export const BootstrapResponseV1Schema = z
  .object({
    version: z.literal("sequences.bootstrap.v1"),
    project: ProjectSummaryV1Schema,
    capabilities: CapabilitiesResponseV1Schema,
    sampleUrl: z.string().min(1),
  })
  .strict();

export type BootstrapResponseV1 = z.infer<typeof BootstrapResponseV1Schema>;
