import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  MUTABLE_JOB_STATES,
  PROJECT_ID,
  JobResponseV1Schema,
  RunReceiptV1Schema,
  type RunReceiptV1,
  type StartJobRequestV1,
} from "../shared";
import type { ServerConfig } from "./config";
import { CodexRunner, codexFailureMessage, type CodexProgress } from "./codex-runner";
import { ApiProblem, errorMessage } from "./errors";
import { existingFileWithin, sha256 } from "./files";
import { HyperframesVerifier } from "./hyperframes";
import { allowedPaths, assertChangedPaths, assertImagePath, inspectChangedFiles } from "./policy";
import { ProjectStore } from "./project-store";
import { RunStore } from "./run-store";
import { SkillBundle } from "./skills";

type JobResponseV1 = z.infer<typeof JobResponseV1Schema>;

const RunManifestV1Schema = z
  .object({
    version: z.literal("sequences.run-manifest.v1"),
    jobId: z.string().regex(/^run_[0-9a-f]{32}$/),
    projectId: z.literal(PROJECT_ID),
    kind: z.enum(["plan", "build", "revision"]),
    createdAt: z.string().datetime(),
    baseCommit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
    allowedPaths: z.array(z.string()).max(100),
    imagePaths: z.array(z.string()).max(4),
  })
  .strict();

export class JobManager {
  private readonly activeProjectJobs = new Map<string, string>();
  private readonly decisionInFlight = new Set<string>();

  constructor(
    private readonly config: ServerConfig,
    private readonly projects: ProjectStore,
    private readonly runs: RunStore,
    private readonly skills: SkillBundle,
    private readonly codex: CodexRunner,
    private readonly hyperframes: HyperframesVerifier,
  ) {}

  async recoverInterruptedJobs(): Promise<void> {
    for (const receipt of await this.runs.list()) {
      if (!MUTABLE_JOB_STATES.has(receipt.state)) continue;
      const failed = await this.runs.transition(receipt.jobId, "failed", {
        error: {
          code: "server_restarted",
          message: "The local server stopped before this job reached a durable review state",
          owner: "server",
        },
      });
      await this.event(failed, "error", "Job stopped because the local server restarted");
    }
  }

  async start(projectId: string, request: StartJobRequestV1): Promise<JobResponseV1> {
    if (projectId !== PROJECT_ID) throw new ApiProblem(404, "project_not_found", "Project not found");
    const active = this.activeProjectJobs.get(projectId);
    if (active) throw new ApiProblem(409, "project_job_active", `Job ${active} is already authoring this project`);

    let scopedPaths: string[];
    try {
      scopedPaths = allowedPaths(request.kind, request.scopePaths);
      for (const image of request.imagePaths ?? []) assertImagePath(image);
    } catch (error) {
      throw new ApiProblem(422, "invalid_job_scope", errorMessage(error));
    }
    const baseCommit = await this.projects.acceptedCommit(projectId);
    if (request.baseCommit && request.baseCommit !== baseCommit) {
      throw new ApiProblem(409, "stale_base", "The requested base commit is no longer accepted HEAD");
    }

    const jobId = `run_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    const receipt = RunReceiptV1Schema.parse({
      version: "sequences.run-receipt.v1",
      jobId,
      projectId: PROJECT_ID,
      kind: request.kind,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      baseCommit,
      candidateRef: `candidate:${jobId}`,
      candidateCommit: null,
      acceptedCommit: null,
      patchSha256: null,
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      codexCliVersion: null,
      sanitizedArguments: [],
      allowedPaths: scopedPaths,
      changedFiles: [],
      skillManifestDigest: null,
      skillsUsed: [],
      exitCode: null,
      timedOut: false,
      cancelRequested: false,
      final: null,
      qa: null,
      decision: null,
      error: null,
    });
    await this.runs.create(receipt);
    await this.event(receipt, "queued", "Job queued from accepted source");
    this.activeProjectJobs.set(projectId, jobId);
    void this.execute(receipt, request)
      .catch((error: unknown) => {
        console.error("[sequences] unrecoverable job persistence failure", errorMessage(error));
      })
      .finally(() => {
        if (this.activeProjectJobs.get(projectId) === jobId) this.activeProjectJobs.delete(projectId);
      });
    return this.response(receipt);
  }

  async get(jobId: string): Promise<JobResponseV1> {
    return this.response(await this.receiptOr404(jobId));
  }

  async events(jobId: string, afterSequence = 0) {
    await this.receiptOr404(jobId);
    return this.runs.events(jobId, afterSequence);
  }

  async cancel(jobId: string): Promise<JobResponseV1> {
    const receipt = await this.receiptOr404(jobId);
    if (!["queued", "preparing", "authoring", "verifying"].includes(receipt.state)) {
      throw new ApiProblem(409, "job_not_cancellable", `A ${receipt.state} job cannot be cancelled`);
    }
    this.codex.cancel(jobId);
    this.hyperframes.cancel(jobId);
    const cancelled = await this.runs.transition(jobId, "cancelled", {
      cancelRequested: true,
      error: null,
    });
    await this.event(cancelled, "complete", "Job cancelled; accepted source was not changed");
    return this.response(cancelled);
  }

  async apply(jobId: string, reason?: string): Promise<JobResponseV1> {
    return this.decision(jobId, async (receipt) => {
      if (receipt.state !== "review_ready" || !receipt.candidateCommit) {
        throw new ApiProblem(409, "candidate_not_review_ready", "Only a verified review-ready candidate can be applied");
      }
      const applying = await this.runs.transition(jobId, "applying");
      await this.event(applying, "decision", "Rechecking accepted HEAD before apply");
      try {
        const acceptedCommit = await this.projects.applyCandidate(receipt.baseCommit, receipt.candidateCommit);
        const applied = await this.runs.transition(jobId, "applied", {
          acceptedCommit,
          decision: {
            action: "applied",
            at: new Date().toISOString(),
            reason: reason ?? null,
          },
        });
        await this.event(applied, "complete", "Candidate applied as the new accepted Hyperframes source");
        return this.response(applied);
      } catch (error) {
        if (error instanceof ApiProblem && error.code === "stale_base") {
          const stale = await this.runs.transition(jobId, "stale", {
            error: { code: "stale_base", message: error.message, owner: "git" },
          });
          await this.event(stale, "error", "Apply blocked because accepted source changed");
          return this.response(stale);
        }
        const failed = await this.runs.transition(jobId, "failed", {
          error: { code: "apply_failed", message: errorMessage(error).slice(0, 4_000), owner: "git" },
        });
        await this.event(failed, "error", "Git could not promote the candidate");
        return this.response(failed);
      }
    });
  }

  async reject(jobId: string, reason?: string): Promise<JobResponseV1> {
    return this.decision(jobId, async (receipt) => {
      if (receipt.state !== "review_ready") {
        throw new ApiProblem(409, "candidate_not_review_ready", "Only a review-ready candidate can be rejected");
      }
      await this.projects.removeCandidate(jobId);
      const rejected = await this.runs.transition(jobId, "rejected", {
        decision: {
          action: "rejected",
          at: new Date().toISOString(),
          reason: reason ?? null,
        },
      });
      await this.event(rejected, "complete", "Candidate rejected; accepted source was not changed");
      return this.response(rejected);
    });
  }

  async listReceipts(): Promise<RunReceiptV1[]> {
    return this.runs.list();
  }

  private async execute(initial: RunReceiptV1, request: StartJobRequestV1): Promise<void> {
    const { jobId } = initial;
    const runRoot = this.projects.runRoot(jobId);
    let skillsInstalled = false;
    try {
      let receipt = await this.runs.transition(jobId, "preparing");
      await this.event(receipt, "preparing", "Creating an isolated Git worktree");
      const candidateRoot = await this.projects.createCandidate(jobId, initial.baseCommit);
      await this.stopIfCancelled(jobId);

      const skillInstall = await this.skills.install(candidateRoot);
      skillsInstalled = true;
      const imagePaths = request.imagePaths ?? [];
      for (const image of imagePaths) {
        const imageFile = await existingFileWithin(candidateRoot, image);
        if ((await lstat(imageFile)).size > 15 * 1_024 * 1_024) throw new Error(`Image input exceeds 15 MiB: ${image}`);
      }
      const manifest = RunManifestV1Schema.parse({
        version: "sequences.run-manifest.v1",
        jobId,
        projectId: PROJECT_ID,
        kind: initial.kind,
        createdAt: initial.createdAt,
        baseCommit: initial.baseCommit,
        promptSha256: sha256(request.prompt),
        allowedPaths: initial.allowedPaths,
        imagePaths,
      });
      await writeFile(join(runRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      receipt = await this.runs.transition(jobId, "authoring", {
        skillManifestDigest: skillInstall.digest,
      });
      await this.event(receipt, "authoring", "GPT-5.6 Luna/high is authoring in the candidate only");

      const codexResult = await this.codex.run({
        jobId,
        kind: initial.kind,
        prompt: request.prompt,
        baseCommit: initial.baseCommit,
        candidateRoot,
        runRoot,
        allowedPaths: initial.allowedPaths,
        imagePaths,
        onProgress: (progress) => this.codexProgress(jobId, progress),
      });
      receipt = await this.runs.update(jobId, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        codexCliVersion: codexResult.cliVersion,
        sanitizedArguments: codexResult.sanitizedArguments,
        exitCode: codexResult.exitCode,
        timedOut: codexResult.timedOut,
      }));
      if (receipt.state === "cancelled") return;
      if (codexResult.timedOut) {
        const timedOut = await this.runs.transition(jobId, "timed_out", {
          error: { code: "codex_timed_out", message: codexFailureMessage(codexResult), owner: "codex" },
        });
        await this.event(timedOut, "error", "Codex reached the explicit job timeout");
        return;
      }
      if (codexResult.cancelled) {
        const cancelled = await this.runs.transition(jobId, "cancelled", { cancelRequested: true });
        await this.event(cancelled, "complete", "Job cancelled; accepted source was not changed");
        return;
      }
      if (codexResult.exitCode !== 0 || !codexResult.final) {
        throw new Error(codexFailureMessage(codexResult));
      }

      await this.skills.verifyInstalled(candidateRoot, skillInstall.digest);
      await this.skills.removeInstalled(candidateRoot);
      skillsInstalled = false;
      const usedSkills = verifyReportedSkills(codexResult.final.skillsUsed, skillInstall.names);
      const changedFiles = await this.projects.changedFiles(candidateRoot, initial.baseCommit);
      assertChangedPaths(changedFiles, initial.allowedPaths);
      await inspectChangedFiles(candidateRoot, changedFiles);
      assertFinalArtifacts(codexResult.final.artifacts, changedFiles);
      await writeFile(join(runRoot, "final.json"), `${JSON.stringify(codexResult.final, null, 2)}\n`, "utf8");

      receipt = await this.runs.transition(jobId, "verifying", {
        final: codexResult.final,
        skillsUsed: usedSkills,
        changedFiles,
      });
      await this.event(receipt, "verifying", "Host is running pinned Hyperframes lint and strict check");
      const qa = await this.hyperframes.verify(jobId, candidateRoot, runRoot);
      receipt = await this.runs.update(jobId, (current) => ({ ...current, qa, updatedAt: new Date().toISOString() }));
      if (receipt.state === "cancelled") return;
      if (!qa.ok) throw new Error("Pinned Hyperframes lint/check hard gates did not pass");
      const unchangedAfterQa = await this.projects.changedFiles(candidateRoot, initial.baseCommit);
      if (JSON.stringify(unchangedAfterQa) !== JSON.stringify(changedFiles)) {
        throw new Error("Host QA unexpectedly changed candidate creative source");
      }

      const candidateCommit = await this.projects.createCandidateCommit(candidateRoot, jobId);
      const patch = await this.projects.candidatePatch(candidateRoot, initial.baseCommit, candidateCommit);
      await writeFile(join(runRoot, "changes.patch"), patch, { encoding: "utf8", mode: 0o600 });
      const ready = await this.runs.transition(jobId, "review_ready", {
        candidateCommit,
        patchSha256: sha256(patch),
      });
      await this.event(ready, "review", "Candidate passed host checks and is ready for human review");
    } catch (error) {
      const current = await this.runs.get(jobId);
      if (["cancelled", "timed_out", "failed"].includes(current.state)) return;
      const failed = await this.runs.transition(jobId, "failed", {
        error: classifyFailure(error),
      });
      await this.event(failed, "error", userFacingFailure(error));
    } finally {
      if (skillsInstalled) {
        // A failed or cancelled workspace is deliberately preserved. Its protected
        // skills are not removed unless their post-run hash was proven unchanged.
        try {
          const current = await this.runs.get(jobId);
          if (current.skillManifestDigest) {
            await this.skills.verifyInstalled(this.projects.candidateRoot(jobId), current.skillManifestDigest);
            await this.skills.removeInstalled(this.projects.candidateRoot(jobId));
          }
        } catch (cleanupError) {
          const updated = await this.runs.update(jobId, (value) => ({
            ...value,
            updatedAt: new Date().toISOString(),
            error: {
              code: "protected_skills_changed",
              message: errorMessage(cleanupError).slice(0, 4_000),
              owner: "policy",
            },
          }));
          await this.event(updated, "error", "Protected Hyperframes skills could not be verified after the job");
        }
      }
    }
  }

  private async stopIfCancelled(jobId: string): Promise<void> {
    if ((await this.runs.get(jobId)).state === "cancelled") throw new Error("Job was cancelled during preparation");
  }

  private async codexProgress(jobId: string, progress: CodexProgress): Promise<void> {
    const receipt = await this.runs.get(jobId);
    if (receipt.state !== "authoring") return;
    await this.event(receipt, "authoring", progress.message, {
      ...(progress.tool ? { tool: progress.tool } : {}),
      ...(progress.currentFile ? { currentFile: progress.currentFile } : {}),
    });
  }

  private async event(
    receipt: RunReceiptV1,
    stage: "queued" | "preparing" | "authoring" | "verifying" | "review" | "decision" | "complete" | "error",
    message: string,
    extra: { currentFile?: string; tool?: string } = {},
  ): Promise<void> {
    await this.runs.appendEvent(
      {
        jobId: receipt.jobId,
        projectId: receipt.projectId,
        state: receipt.state,
        stage,
        message,
        ...extra,
      },
      receipt.createdAt,
    );
  }

  private async receiptOr404(jobId: string): Promise<RunReceiptV1> {
    try {
      return await this.runs.get(jobId);
    } catch (error) {
      if (!isMissing(error)) throw error;
      throw new ApiProblem(404, "job_not_found", "Job not found");
    }
  }

  private response(receipt: RunReceiptV1): JobResponseV1 {
    const base = `/api/v1/projects/${PROJECT_ID}/files/${this.config.staticAccessToken}/candidate/${receipt.jobId}/index.html`;
    return {
      version: "sequences.job-response.v1",
      receipt,
      eventsUrl: `/api/v1/jobs/${receipt.jobId}/events`,
      candidateUrl: base,
    };
  }

  private async decision(
    jobId: string,
    operation: (receipt: RunReceiptV1) => Promise<JobResponseV1>,
  ): Promise<JobResponseV1> {
    if (this.decisionInFlight.has(jobId)) throw new ApiProblem(409, "decision_in_progress", "A candidate decision is already in progress");
    this.decisionInFlight.add(jobId);
    try {
      return await operation(await this.receiptOr404(jobId));
    } finally {
      this.decisionInFlight.delete(jobId);
    }
  }
}

function verifyReportedSkills(reported: readonly string[], installed: readonly string[]): string[] {
  const installedSet = new Set(installed);
  const normalized = [...new Set(reported.map(skillName))].sort();
  for (const skill of normalized) {
    if (!installedSet.has(skill)) throw new Error(`Codex reported an unknown Hyperframes skill: ${skill}`);
  }
  for (const required of ["hyperframes", "general-video"]) {
    if (!normalized.includes(required)) throw new Error(`Codex did not report reading required skill: ${required}`);
  }
  return normalized;
}

function skillName(value: string): string {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  const skillsIndex = parts.lastIndexOf("skills");
  return skillsIndex >= 0 && parts[skillsIndex + 1] ? parts[skillsIndex + 1]! : (parts[0] ?? value);
}

function assertFinalArtifacts(reported: readonly string[], changed: readonly string[]): void {
  const left = [...new Set(reported)].sort();
  const right = [...new Set(changed)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error("Codex final artifact inventory does not exactly match the candidate Git diff");
  }
}

function classifyFailure(error: unknown): RunReceiptV1["error"] {
  const message = errorMessage(error).slice(0, 4_000);
  if (/hyperframes|lint|strict check/i.test(message)) return { code: "hyperframes_verification_failed", message, owner: "hyperframes" };
  if (/git|worktree|commit/i.test(message)) return { code: "git_candidate_failed", message, owner: "git" };
  if (/codex|gpt-5\.6/i.test(message)) return { code: "codex_authoring_failed", message, owner: "codex" };
  if (/skill|scope|protected|external asset|artifact inventory/i.test(message)) return { code: "candidate_policy_failed", message, owner: "policy" };
  return { code: "job_failed", message, owner: "server" };
}

function userFacingFailure(error: unknown): string {
  const message = errorMessage(error);
  if (/lint|strict check|Hyperframes/i.test(message)) return "Candidate did not pass the pinned Hyperframes verification gate";
  if (/scope|protected|external asset/i.test(message)) return "Candidate changed content outside its approved safety scope";
  if (/Codex/i.test(message)) return "Codex authoring ended without a valid review candidate";
  return "Job failed before reaching review; accepted source was not changed";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
