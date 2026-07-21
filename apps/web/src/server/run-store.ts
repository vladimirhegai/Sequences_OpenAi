import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  JobEventV1Schema,
  RunReceiptV1Schema,
  type JobEventV1,
  type JobState,
  type RunReceiptV1,
} from "../shared";
import { atomicWriteJson, readJson } from "./files";
import type { ProjectStore } from "./project-store";

type EventInput = Omit<JobEventV1, "version" | "sequence" | "at" | "elapsedMs">;

const ALLOWED_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["preparing", "cancelled", "failed"],
  preparing: ["authoring", "cancelled", "failed"],
  authoring: ["verifying", "cancelled", "timed_out", "failed"],
  verifying: ["review_ready", "applying", "cancelled", "timed_out", "failed"],
  review_ready: ["applying", "rejected", "stale"],
  applying: ["applied", "stale", "failed"],
  applied: [],
  rejected: [],
  stale: [],
  failed: [],
  timed_out: [],
  cancelled: [],
};

export class RunStore {
  private readonly receiptCache = new Map<string, RunReceiptV1>();
  private readonly receiptTails = new Map<string, Promise<unknown>>();
  private readonly eventTails = new Map<string, Promise<unknown>>();
  private readonly sequences = new Map<string, number>();

  constructor(private readonly projects: ProjectStore) {}

  async create(receipt: RunReceiptV1): Promise<RunReceiptV1> {
    const root = this.projects.runRoot(receipt.jobId);
    await mkdir(root, { recursive: false });
    await writeFile(join(root, "events.jsonl"), "", { encoding: "utf8", mode: 0o600 });
    const parsed = await atomicWriteJson(join(root, "receipt.json"), RunReceiptV1Schema, receipt);
    this.receiptCache.set(receipt.jobId, parsed);
    this.sequences.set(receipt.jobId, 0);
    return parsed;
  }

  async get(jobId: string): Promise<RunReceiptV1> {
    const cached = this.receiptCache.get(jobId);
    if (cached) return cached;
    const receipt = await readJson(
      join(this.projects.runRoot(jobId), "receipt.json"),
      RunReceiptV1Schema,
    );
    this.receiptCache.set(jobId, receipt);
    return receipt;
  }

  async update(
    jobId: string,
    update: (receipt: RunReceiptV1) => RunReceiptV1,
  ): Promise<RunReceiptV1> {
    return this.serialized(this.receiptTails, jobId, async () => {
      const current = await this.get(jobId);
      const next = RunReceiptV1Schema.parse(update(current));
      const persisted = await atomicWriteJson(
        join(this.projects.runRoot(jobId), "receipt.json"),
        RunReceiptV1Schema,
        next,
      );
      this.receiptCache.set(jobId, persisted);
      return persisted;
    });
  }

  async transition(
    jobId: string,
    state: JobState,
    patch: Partial<RunReceiptV1> = {},
  ): Promise<RunReceiptV1> {
    return this.update(jobId, (current) => {
      if (current.state !== state && !ALLOWED_TRANSITIONS[current.state].includes(state)) {
        throw new Error(`Invalid job state transition: ${current.state} -> ${state}`);
      }
      const now = new Date().toISOString();
      const finished = [
        "applied",
        "rejected",
        "stale",
        "failed",
        "timed_out",
        "cancelled",
      ].includes(state);
      return {
        ...current,
        ...patch,
        jobId: current.jobId,
        projectId: current.projectId,
        version: current.version,
        state,
        updatedAt: now,
        finishedAt: finished ? now : null,
      };
    });
  }

  async appendEvent(input: EventInput, createdAt: string): Promise<JobEventV1> {
    return this.serialized(this.eventTails, input.jobId, async () => {
      let sequence = this.sequences.get(input.jobId);
      if (sequence === undefined) {
        sequence = (await this.events(input.jobId)).at(-1)?.sequence ?? 0;
      }
      const event = JobEventV1Schema.parse({
        ...input,
        version: "sequences.job-event.v1",
        sequence: sequence + 1,
        at: new Date().toISOString(),
        elapsedMs: Math.max(0, Date.now() - new Date(createdAt).getTime()),
      });
      await appendFile(
        join(this.projects.runRoot(input.jobId), "events.jsonl"),
        `${JSON.stringify(event)}\n`,
        "utf8",
      );
      this.sequences.set(input.jobId, event.sequence);
      return event;
    });
  }

  async events(jobId: string, afterSequence = 0): Promise<JobEventV1[]> {
    const path = join(this.projects.runRoot(jobId), "events.jsonl");
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 8 * 1_024 * 1_024) {
      throw new Error("Persisted job event log exceeds its 8 MiB safety limit");
    }
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JobEventV1Schema.parse(JSON.parse(line) as unknown))
      .filter((event) => event.sequence > afterSequence);
  }

  async list(): Promise<RunReceiptV1[]> {
    const entries = await readdir(this.projects.runsDirectory(), { withFileTypes: true });
    const receipts: RunReceiptV1[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run_[0-9a-f]{32}$/.test(entry.name)) continue;
      receipts.push(await this.get(entry.name));
    }
    return receipts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async serialized<T>(
    tails: Map<string, Promise<unknown>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}
