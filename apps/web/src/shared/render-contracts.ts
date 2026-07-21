import { z } from "zod";
import { GitCommitSchema, ProjectIdSchema } from "./job-contracts";

export const RenderIdSchema = z.string().regex(/^render_[0-9a-f]{32}$/);
export const RenderQualitySchema = z.enum(["draft", "standard", "high"]);
export const RenderStateSchema = z.enum([
  "queued",
  "preparing",
  "rendering",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]);

export type RenderState = z.infer<typeof RenderStateSchema>;

export const StartRenderRequestV1Schema = z
  .object({
    version: z.literal("sequences.start-render.v1"),
    quality: RenderQualitySchema.default("standard"),
  })
  .strict();

export type StartRenderRequestV1 = z.infer<typeof StartRenderRequestV1Schema>;

export const RenderActionRequestV1Schema = z
  .object({ version: z.literal("sequences.render-action.v1") })
  .strict();

const RenderErrorV1Schema = z
  .object({
    code: z.string().regex(/^[a-z0-9_]+$/),
    message: z.string().min(1).max(4_000),
    owner: z.enum(["server", "git", "hyperframes", "ffmpeg"]),
  })
  .strict();

const RenderProgressV1Schema = z
  .object({
    stage: z.enum(["queued", "snapshot", "render", "verify", "complete", "error"]),
    percent: z.number().int().min(0).max(100),
    message: z.string().min(1).max(500),
  })
  .strict();

const VideoArtifactV1Schema = z
  .object({
    path: z.string().min(1).max(500),
    downloadUrl: z.string().min(1).max(500),
    bytes: z.number().int().positive(),
    codec: z.string().min(1).max(80),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().finite().positive(),
    durationSeconds: z.number().finite().positive(),
  })
  .strict();

const SourceBundleArtifactV1Schema = z
  .object({
    path: z.string().min(1).max(500),
    downloadUrl: z.string().min(1).max(500),
    bytes: z.number().int().positive(),
  })
  .strict();

const AudioMixArtifactV1Schema = z
  .object({
    soundtrackId: z.string().min(1).max(60),
    cueCount: z.number().int().nonnegative().max(20),
    codec: z.string().min(1).max(80),
  })
  .strict();

export const RenderReceiptV1Schema = z
  .object({
    version: z.literal("sequences.render-receipt.v1"),
    renderId: RenderIdSchema,
    projectId: ProjectIdSchema,
    state: RenderStateSchema,
    quality: RenderQualitySchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    acceptedCommit: GitCommitSchema,
    progress: RenderProgressV1Schema,
    cancelRequested: z.boolean(),
    artifacts: z
      .object({
        video: VideoArtifactV1Schema,
        sourceBundle: SourceBundleArtifactV1Schema,
        firstFramePath: z.string().min(1).max(500),
        lastFramePath: z.string().min(1).max(500),
        // Absent on receipts written before the audio-direction port; null on
        // films whose director declared no sound plan.
        audio: AudioMixArtifactV1Schema.nullable().default(null),
      })
      .strict()
      .nullable(),
    error: RenderErrorV1Schema.nullable(),
  })
  .strict();

export type RenderReceiptV1 = z.infer<typeof RenderReceiptV1Schema>;

export const RenderResponseV1Schema = z
  .object({
    version: z.literal("sequences.render-response.v1"),
    receipt: RenderReceiptV1Schema,
  })
  .strict();

export type RenderResponseV1 = z.infer<typeof RenderResponseV1Schema>;
