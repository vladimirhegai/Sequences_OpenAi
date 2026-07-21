import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { JobIdSchema, PROJECT_ID } from "../shared";
import type { ServerConfig } from "./config";
import { atomicWriteJson, readJson } from "./files";

const DirectorRecordV1Schema = z
  .object({
    version: z.literal("sequences.director-record.v1"),
    projectId: z.literal(PROJECT_ID),
    generation: z.number().int().nonnegative(),
    threadId: z.string().uuid().nullable(),
    lastRunId: JobIdSchema.nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type DirectorRecordV1 = z.infer<typeof DirectorRecordV1Schema>;

export interface DirectorSessionPlan {
  mode: "continue" | "reset";
  generation: number;
  threadId: string | null;
  parentRunId: string | null;
}

export class DirectorStore {
  private readonly path: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(config: ServerConfig) {
    this.path = resolve(config.runsRoot, "..", `director-${PROJECT_ID}.json`);
  }

  async get(): Promise<DirectorRecordV1> {
    try {
      return await readJson(this.path, DirectorRecordV1Schema);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return {
        version: "sequences.director-record.v1",
        projectId: PROJECT_ID,
        generation: 0,
        threadId: null,
        lastRunId: null,
        updatedAt: new Date(0).toISOString(),
      };
    }
  }

  async plan(mode: "continue" | "reset"): Promise<DirectorSessionPlan> {
    const current = await this.get();
    if (mode === "reset" || !current.threadId) {
      return {
        mode,
        generation: current.generation + 1,
        threadId: null,
        parentRunId: mode === "reset" ? null : current.lastRunId,
      };
    }
    return {
      mode,
      generation: current.generation,
      threadId: current.threadId,
      parentRunId: current.lastRunId,
    };
  }

  async record(
    plan: DirectorSessionPlan,
    jobId: string,
    threadId: string,
  ): Promise<DirectorRecordV1> {
    const operation = this.tail
      .catch(() => undefined)
      .then(async () => {
        JobIdSchema.parse(jobId);
        const next = DirectorRecordV1Schema.parse({
          version: "sequences.director-record.v1",
          projectId: PROJECT_ID,
          generation: plan.generation,
          threadId,
          lastRunId: jobId,
          updatedAt: new Date().toISOString(),
        });
        await mkdir(dirname(this.path), { recursive: true });
        return atomicWriteJson(this.path, DirectorRecordV1Schema, next);
      });
    this.tail = operation;
    return operation;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
