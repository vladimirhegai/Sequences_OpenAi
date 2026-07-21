import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ComponentPlanV2Schema,
  MUTABLE_JOB_STATES,
  PROJECT_ID,
  JobResponseV1Schema,
  ImageInputV1Schema,
  LayoutInspectionV1Schema,
  LayoutRepairAttemptV1Schema,
  QaRemediationV1Schema,
  RunReceiptV1Schema,
  type QaReceiptV1,
  type AgentRole,
  type CodexOperation,
  type CodexFinalV1,
  type DesignCapsuleV1,
  type ImageInputV1,
  type LayoutClusterV1,
  type RevisionScopeV1,
  type RunReceiptV1,
  type SequenceArtifactV1,
  type StartJobRequestV1,
} from "../shared";
import { AudioDirector } from "./audio-director";
import { AuthorContextGateway } from "./author-context";
import { captureCandidateCheckpoint, type CandidateCheckpoint } from "./candidate-checkpoint";
import { resolveAgentRoute, type AgentRoute, type ServerConfig } from "./config";
import {
  CodexRunner,
  codexFailureMessage,
  isTransientCodexFailure,
  type CodexProgress,
  type CodexRunRequest,
  type CodexRunResult,
} from "./codex-runner";
import { DirectorStore } from "./director-store";
import { ApiProblem, errorMessage } from "./errors";
import { existingFileWithin, sha256 } from "./files";
import { HyperframesVerifier } from "./hyperframes";
import { isRepairableLayoutFinding } from "./layout-clusters";
import {
  allowedPaths,
  assertChangedPaths,
  assertImagePath,
  inspectChangedFiles,
  pathMatches,
} from "./policy";
import { ProjectStore } from "./project-store";
import {
  assertComponentPlan,
  canonicalizeComponentPlanStateClaims,
  normalizeComponentPlanContainment,
  normalizeComponentPlanReferenceBindings,
} from "./component-plan";
import {
  assertDesignCapsule,
  assertDesignCapsuleDirection,
  DESIGN_CAPSULE_PATH,
  normalizeDesignCapsuleMotionVerbs,
  readDesignCapsule,
  repairUnusedDesignTokenBindings,
} from "./design-capsule";
import { ProofComparator } from "./proof-comparator";
import { ContrastFixer } from "./qa-fixers/contrast";
import { TweenOverlapFixer } from "./qa-fixers/tween-overlap";
import { RunStore } from "./run-store";
import {
  assertLaunchMotionSidecar,
  assertLaunchSequenceSemantics,
  assertFreshBuildAuthored,
  assertSemanticRevisionContained,
  normalizeLaunchMotionSidecarTargets,
  normalizeDomCameraOwners,
  normalizeNumericMusicAnchors,
  readSequenceArtifact,
  resolveRevisionScope,
  revisionImplementationFiles,
  type MotionSelectorMissingNormalization,
} from "./sequence-artifact";
import { SkillBundle } from "./skills";
import {
  CREATIVE_STAGE_PATHS,
  PREPRODUCTION_STAGE_PATHS,
  assertArtifactDigests,
  assertVisualAuditBindings,
  captureArtifactDigests,
  componentStagePaths,
  compositorStagePaths,
  createTemporalEvidence,
  missingPreproductionPaths,
  temporalEvidenceSnapshotTimes,
  type ArtifactDigest,
} from "./agent-workflow";

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
    imageInputs: z.array(ImageInputV1Schema).max(4),
    directorMode: z.enum(["continue", "reset"]),
    revision: z.unknown().nullable(),
  })
  .strict();

// QA artifacts share one monotonically numbered ledger, but each repair class
// owns a separate bounded slice. Pre-layout deterministic fixers may consume
// attempts 2..4; all three layout turns then remain available through attempt
// 7, post-layout deterministic cleanup through 10, and two final same-thread
// non-layout repairs through 12.
const LAYOUT_QA_ATTEMPT_CEILING = 8;
const POST_LAYOUT_QA_ATTEMPT_CEILING = 10;
const FINAL_QA_ATTEMPT_CEILING = 12;
// Fresh-build custody spans four independently validated layers: semantic
// sequence, motion sidecar, design capsule, and component plan. A failure in
// an earlier layer can make a later layer impossible to validate, so a global
// two-turn budget can reject a converging candidate before the later evidence
// is ever actionable. Keep one bounded turn per layer and stop sooner when the
// authoritative failure packet repeats unchanged.
const MAX_CONTRACT_REPAIR_ATTEMPTS = 4;
const RECOVERABLE_FRESH_BUILD_FILES = [
  "frame.md",
  "index.html",
  "index.motion.json",
  "sequence.json",
  "story/design-capsule.json",
  "story/component-plan.json",
] as const;

export class JobManager {
  private readonly activeProjectJobs = new Map<string, string>();
  private readonly startingProjectJobs = new Set<string>();
  private readonly directors: DirectorStore;
  private readonly contexts: AuthorContextGateway;
  private readonly proofs: ProofComparator;
  private readonly contrastFixer: ContrastFixer;
  private readonly tweenOverlapFixer: TweenOverlapFixer;
  private readonly audio: AudioDirector;

  constructor(
    private readonly config: ServerConfig,
    private readonly projects: ProjectStore,
    private readonly runs: RunStore,
    private readonly skills: SkillBundle,
    private readonly codex: CodexRunner,
    private readonly hyperframes: HyperframesVerifier,
    proofs?: ProofComparator,
  ) {
    this.audio = new AudioDirector(config.workspaceRoot);
    this.directors = new DirectorStore(config);
    this.contexts = new AuthorContextGateway(config, this.audio);
    this.proofs = proofs ?? new ProofComparator(config);
    this.contrastFixer = new ContrastFixer();
    this.tweenOverlapFixer = new TweenOverlapFixer();
  }

  async recoverInterruptedJobs(): Promise<void> {
    for (const receipt of await this.runs.list()) {
      if (!MUTABLE_JOB_STATES.has(receipt.state)) continue;
      if (receipt.state === "applying" && receipt.candidateCommit) {
        try {
          const currentAccepted = await this.projects.acceptedCommit(receipt.projectId);
          const acceptedCommit =
            currentAccepted === receipt.candidateCommit
              ? currentAccepted
              : await this.projects.applyCandidate(receipt.baseCommit, receipt.candidateCommit);
          const applied = await this.runs.transition(receipt.jobId, "applied", {
            acceptedCommit,
            decision: null,
          });
          await this.event(applied, "complete", "Generated video is ready on the timeline");
          continue;
        } catch (error) {
          if (error instanceof ApiProblem && error.code === "stale_base") {
            const stale = await this.runs.transition(receipt.jobId, "stale", {
              error: { code: "stale_base", message: error.message, owner: "git" },
            });
            await this.event(stale, "error", "Interrupted promotion could not be resumed safely");
            continue;
          }
          const failed = await this.runs.transition(receipt.jobId, "failed", {
            error: classifyFailure(error),
          });
          await this.event(failed, "error", "Interrupted promotion could not be recovered");
          continue;
        }
      }
      const failed = await this.runs.transition(receipt.jobId, "failed", {
        error: {
          code: "server_restarted",
          message: "The local server stopped before this job reached a durable timeline result",
          owner: "server",
        },
      });
      await this.event(failed, "error", "Job stopped because the local server restarted");
    }
  }

  async start(projectId: string, request: StartJobRequestV1): Promise<JobResponseV1> {
    if (projectId !== PROJECT_ID)
      throw new ApiProblem(404, "project_not_found", "Project not found");
    const active = this.activeProjectJobs.get(projectId);
    if (active || this.startingProjectJobs.has(projectId)) {
      throw new ApiProblem(
        409,
        "project_job_active",
        active
          ? `Job ${active} is already authoring this project`
          : "A job is already preparing this project",
      );
    }
    this.startingProjectJobs.add(projectId);
    try {
      return await this.startReserved(projectId, request);
    } finally {
      this.startingProjectJobs.delete(projectId);
    }
  }

  private async startReserved(
    projectId: string,
    request: StartJobRequestV1,
  ): Promise<JobResponseV1> {
    if (projectId !== PROJECT_ID)
      throw new ApiProblem(404, "project_not_found", "Project not found");
    enforceFreshBuildMode(request);
    const active = this.activeProjectJobs.get(projectId);
    if (active)
      throw new ApiProblem(
        409,
        "project_job_active",
        `Job ${active} is already authoring this project`,
      );

    const baseCommit = await this.projects.checkpointAcceptedChanges(
      "Checkpoint local accepted-source edits before generation",
    );
    if (request.baseCommit && request.baseCommit !== baseCommit) {
      throw new ApiProblem(
        409,
        "stale_base",
        "The requested base commit is no longer accepted HEAD",
      );
    }
    let scopedPaths: string[];
    let revision: RevisionScopeV1 | undefined;
    try {
      const requestedImages = request.imagePaths ?? [];
      if (new Set(requestedImages).size !== requestedImages.length) {
        throw new Error("Image inputs must use distinct staged paths");
      }
      for (const image of requestedImages) {
        assertImagePath(image);
        await this.projects.readImageInput(image);
      }
      if (request.kind === "revision") {
        const sequence = await readSequenceArtifact(this.projects.acceptedRoot(projectId));
        revision = resolveRevisionScope(sequence!, request.revision!);
        scopedPaths = allowedPaths(
          request.kind,
          request.scopePaths ?? revisionImplementationFiles(sequence!, revision),
        );
      } else {
        scopedPaths = allowedPaths(request.kind, request.scopePaths);
      }
    } catch (error) {
      throw new ApiProblem(422, "invalid_job_scope", errorMessage(error));
    }
    const executionRequest: StartJobRequestV1 = {
      ...request,
      ...(request.kind === "build" ? { directorMode: "reset" as const } : {}),
      ...(revision ? { revision } : {}),
    };

    const jobId = `run_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    const workflowMode =
      request.kind === "build" ? this.config.agentWorkflowMode : ("legacy" as const);
    const primaryRole: AgentRole = workflowMode === "balanced" ? "compositor" : "legacy_director";
    const primaryRoute = resolveAgentRoute(this.config, primaryRole);
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
      inversePatchSha256: null,
      model: primaryRoute.model,
      reasoningEffort: primaryRoute.reasoningEffort,
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
      qaRemediations: [],
      layoutRepairs: [],
      agentWorkflow: {
        version: "sequences.agent-workflow.v1",
        mode: workflowMode,
        componentSpecialist: false,
        turns: [],
        compositorThreadId: null,
        temporalEvidenceArtifact: null,
        visualAuditArtifact: null,
      },
      visualAudit: null,
      director: null,
      context: null,
      proofComparison: null,
      decision: null,
      error: null,
    });
    await this.runs.create(receipt);
    await this.event(receipt, "queued", "Job queued for a fresh video build");
    this.activeProjectJobs.set(projectId, jobId);
    void this.execute(receipt, executionRequest)
      .catch((error: unknown) => {
        console.error("[sequences] unrecoverable job persistence failure", errorMessage(error));
      })
      .finally(() => {
        if (this.activeProjectJobs.get(projectId) === jobId)
          this.activeProjectJobs.delete(projectId);
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
      throw new ApiProblem(
        409,
        "job_not_cancellable",
        `A ${receipt.state} job cannot be cancelled`,
      );
    }
    this.codex.cancel(jobId);
    this.hyperframes.cancel(jobId);
    const cancelled = await this.runs.transition(jobId, "cancelled", {
      cancelRequested: true,
      error: null,
    });
    await this.event(
      cancelled,
      "complete",
      "Job cancelled; the previous timeline video is unchanged",
    );
    return this.response(cancelled);
  }

  async listReceipts(): Promise<RunReceiptV1[]> {
    return this.runs.list();
  }

  async directorSummary(): Promise<{ generation: number; active: boolean }> {
    const director = await this.directors.get();
    return { generation: director.generation, active: director.threadId !== null };
  }

  private async execute(initial: RunReceiptV1, request: StartJobRequestV1): Promise<void> {
    const { jobId } = initial;
    const runRoot = this.projects.runRoot(jobId);
    const workflowMode = initial.agentWorkflow.mode;
    const primaryRole: AgentRole = workflowMode === "balanced" ? "compositor" : "legacy_director";
    const primaryRoute = resolveAgentRoute(this.config, primaryRole);
    let creativeLocks: ArtifactDigest[] = [];
    let componentLocks: ArtifactDigest[] = [];
    let componentSpecialist = false;
    let compositorCheckpoint: CandidateCheckpoint | null = null;
    let skillsInstalled = false;
    const motionSelectorMissingNormalizations = new Map<
      string,
      MotionSelectorMissingNormalization
    >();
    const recordMotionSelectorMissing = (finding: MotionSelectorMissingNormalization): void => {
      motionSelectorMissingNormalizations.set(
        `${finding.assertionKind}:${finding.selectors.join("\u0000")}`,
        finding,
      );
    };
    try {
      let receipt = await this.runs.transition(jobId, "preparing");
      await this.event(
        receipt,
        "preparing",
        request.kind === "build"
          ? "Creating a fresh HyperFrames project from scratch"
          : "Creating an isolated Git worktree",
      );
      const prepared =
        request.kind === "build"
          ? await this.projects.createFreshCandidate(
              jobId,
              initial.baseCommit,
              request.imagePaths ?? [],
            )
          : {
              candidate: await this.projects.createCandidate(jobId, initial.baseCommit),
              baseCommit: initial.baseCommit,
            };
      const candidateRoot = prepared.candidate;
      const baseCommit = prepared.baseCommit;
      receipt = await this.runs.update(jobId, (current) => ({
        ...current,
        baseCommit,
        updatedAt: new Date().toISOString(),
      }));
      await this.stopIfCancelled(jobId);

      const skillInstall = await this.skills.install(candidateRoot);
      skillsInstalled = true;
      const directorPlan = await this.directors.plan(request.directorMode);
      const baseSequence =
        request.kind === "revision" ? await readSequenceArtifact(candidateRoot, true) : null;
      let contextResult = await this.contexts.prepare({
        runRoot,
        acceptedCommit: baseCommit,
        skills: skillInstall.catalog,
        prompt: request.prompt,
        sequence: baseSequence,
        revisionScope: request.revision ?? null,
      });
      const imagePaths = request.imagePaths ?? [];
      const imageInputs = await Promise.all(
        imagePaths.map((image) => this.projects.readImageInput(image)),
      );
      for (const image of imageInputs) {
        const imageFile = await existingFileWithin(candidateRoot, image.path);
        if ((await lstat(imageFile)).size > 15 * 1_024 * 1_024)
          throw new Error(`Image input exceeds 15 MiB: ${image.path}`);
      }
      const manifest = RunManifestV1Schema.parse({
        version: "sequences.run-manifest.v1",
        jobId,
        projectId: PROJECT_ID,
        kind: initial.kind,
        createdAt: initial.createdAt,
        baseCommit,
        promptSha256: sha256(request.prompt),
        allowedPaths:
          workflowMode === "balanced"
            ? compositorStagePaths(componentSpecialist)
            : initial.allowedPaths,
        imagePaths,
        imageInputs,
        directorMode: request.directorMode,
        revision: request.revision ?? null,
      });
      await writeFile(
        join(runRoot, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        join(runRoot, "prompt.json"),
        `${JSON.stringify(
          {
            version: "sequences.prompt-receipt.v1",
            prompt: request.prompt,
            promptSha256: sha256(request.prompt),
            kind: request.kind,
            directorMode: request.directorMode,
            revision: request.revision ?? null,
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      if (workflowMode === "balanced" && request.kind === "build") {
        const staged = await this.runBalancedPrecompositionStages({
          receipt,
          jobId,
          candidateRoot,
          runRoot,
          baseCommit,
          prompt: request.prompt,
          imagePaths,
          skillProfile: skillInstall.catalog,
          authorContext: contextResult.context,
        });
        creativeLocks = staged.creativeLocks;
        componentLocks = staged.componentLocks;
        componentSpecialist = staged.componentSpecialist;
        const lockedSequence = await readSequenceArtifact(candidateRoot);
        if (!lockedSequence) throw new Error("Preproduction did not leave a locked sequence");
        contextResult = await this.contexts.prepare({
          runRoot,
          acceptedCommit: baseCommit,
          skills: skillInstall.catalog,
          prompt: request.prompt,
          sequence: lockedSequence,
          revisionScope: null,
        });
        compositorCheckpoint = await captureCandidateCheckpoint(candidateRoot);
        receipt = await this.runs.update(jobId, (current) => ({
          ...current,
          agentWorkflow: {
            ...current.agentWorkflow,
            componentSpecialist,
          },
          updatedAt: new Date().toISOString(),
        }));
      }
      receipt = await this.runs.transition(jobId, "authoring", {
        skillManifestDigest: skillInstall.digest,
        context: contextResult.receipt,
      });
      await this.event(
        receipt,
        "authoring",
        `${primaryRoute.model}/${primaryRoute.reasoningEffort} ${workflowMode === "balanced" ? "is composing the locked direction" : "is authoring the new video"}`,
      );

      let codexResult = await this.runCodexTurn({
        jobId,
        kind: initial.kind,
        prompt: request.prompt,
        baseCommit,
        candidateRoot,
        runRoot,
        allowedPaths:
          workflowMode === "balanced"
            ? compositorStagePaths(componentSpecialist)
            : initial.allowedPaths,
        imagePaths,
        skillProfile: skillInstall.catalog,
        authorContext: contextResult.context,
        threadId: directorPlan.threadId,
        ...(workflowMode === "balanced" ? { operation: "author" as const } : {}),
        agentRole: primaryRole,
        model: primaryRoute.model,
        reasoningEffort: primaryRoute.reasoningEffort,
        workflowHandoff:
          workflowMode === "balanced"
            ? { creativeLocked: true, componentPlanLocked: componentSpecialist }
            : undefined,
        ...(workflowMode === "balanced" ? { artifactDirectory: "turns/workflow-composition" } : {}),
        onProgress: (progress) => this.codexProgress(jobId, progress),
      });
      if (compositorCheckpoint) {
        await this.restoreOutOfScopeTurnChanges({
          jobId,
          stage: "authoring",
          actor: "compositor",
          checkpoint: compositorCheckpoint,
          allowedPaths: compositorStagePaths(componentSpecialist),
        });
      }
      if (!codexResult.final && codexResult.diskComplete && !codexResult.cancelled) {
        const changedDuringAuthoring = (
          await this.projects.changedFiles(candidateRoot, baseCommit)
        ).filter((path) => !path.startsWith(".agents/"));
        const diskFinal = await recoverAuthorFinalFromDisk({
          candidateRoot,
          kind: request.kind,
          originalPrompt: request.prompt,
          changedDuringAuthoring,
          allowedPaths: initial.allowedPaths,
          requiredSkills: skillInstall.requiredSkills,
        });
        if (diskFinal) {
          await this.event(
            receipt,
            "authoring",
            "Complete compositor artifacts accepted from disk without a redundant recovery turn",
            { tool: "workflow-disk-truth" },
          );
          codexResult = {
            ...codexResult,
            final: diskFinal,
            exitCode: 0,
            timedOut: false,
            upstreamError: null,
          };
        }
      }
      if (!codexResult.cancelled && (codexResult.exitCode !== 0 || !codexResult.final)) {
        await this.event(
          receipt,
          "authoring",
          "The first author turn did not materialize a complete candidate; resuming the exact thread once",
          { tool: "codex" },
        );
        let recoveryResult = await this.runCodexTurn({
          jobId,
          kind: initial.kind,
          prompt: authorRecoveryPrompt(
            codexFailureMessage(codexResult),
            workflowMode === "balanced" ? "compositor" : "Luna director",
          ),
          baseCommit,
          candidateRoot,
          runRoot,
          allowedPaths:
            workflowMode === "balanced"
              ? compositorStagePaths(componentSpecialist)
              : initial.allowedPaths,
          // A resumed author turn must receive the same trusted visual
          // evidence as the website request. Passing an empty list here made
          // the recovery prompt explicitly claim that no references existed,
          // which could turn a four-image build into a synthetic one.
          imagePaths,
          skillProfile: skillInstall.catalog,
          authorContext: contextResult.context,
          threadId: codexResult.threadId,
          operation: "author_recovery",
          agentRole: primaryRole,
          model: primaryRoute.model,
          reasoningEffort: primaryRoute.reasoningEffort,
          workflowHandoff:
            workflowMode === "balanced"
              ? { creativeLocked: true, componentPlanLocked: componentSpecialist }
              : undefined,
          artifactDirectory: "turns/author-recovery-1",
          onProgress: (progress) => this.codexProgress(jobId, progress),
        });
        if (compositorCheckpoint) {
          await this.restoreOutOfScopeTurnChanges({
            jobId,
            stage: "authoring",
            actor: "compositor recovery",
            checkpoint: compositorCheckpoint,
            allowedPaths: compositorStagePaths(componentSpecialist),
          });
        }
        if (!recoveryResult.resumed || recoveryResult.threadId !== codexResult.threadId) {
          throw new Error("Author recovery did not resume the exact owning thread");
        }
        if (
          !recoveryResult.cancelled &&
          (recoveryResult.timedOut || recoveryResult.exitCode !== 0 || !recoveryResult.final)
        ) {
          const changedDuringAuthoring = (
            await this.projects.changedFiles(candidateRoot, baseCommit)
          ).filter((path) => !path.startsWith(".agents/"));
          const recoveredFinal = await recoverAuthorFinalFromDisk({
            candidateRoot,
            kind: request.kind,
            originalPrompt: request.prompt,
            changedDuringAuthoring,
            allowedPaths: initial.allowedPaths,
            requiredSkills: skillInstall.requiredSkills,
          });
          if (recoveredFinal) {
            await this.event(
              receipt,
              "authoring",
              "The recovery process ended without a final response, but its complete disk candidate will continue through the normal contract and strict QA gates",
              { tool: "filesystem" },
            );
            recoveryResult = {
              ...recoveryResult,
              final: recoveredFinal,
              exitCode: 0,
              timedOut: false,
              upstreamError: null,
            };
          }
        }
        codexResult = recoveryResult;
      }
      await this.directors.record(directorPlan, jobId, codexResult.threadId);
      receipt = await this.runs.update(jobId, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        codexCliVersion: codexResult.cliVersion,
        sanitizedArguments: codexResult.sanitizedArguments,
        exitCode: codexResult.exitCode,
        timedOut: codexResult.timedOut,
        agentWorkflow: {
          ...current.agentWorkflow,
          compositorThreadId:
            workflowMode === "balanced"
              ? codexResult.threadId
              : current.agentWorkflow.compositorThreadId,
        },
        director: {
          mode: directorPlan.mode,
          generation: directorPlan.generation,
          threadId: codexResult.threadId,
          resumed: codexResult.resumed,
          parentRunId: directorPlan.parentRunId,
        },
      }));
      if (receipt.state === "cancelled") return;
      if (codexResult.timedOut) {
        const timedOut = await this.runs.transition(jobId, "timed_out", {
          error: {
            code: "codex_timed_out",
            message: codexFailureMessage(codexResult),
            owner: "codex",
          },
        });
        await this.event(timedOut, "error", "Codex reached the explicit job timeout");
        return;
      }
      if (codexResult.cancelled) {
        const cancelled = await this.runs.transition(jobId, "cancelled", { cancelRequested: true });
        await this.event(
          cancelled,
          "complete",
          "Job cancelled; the previous timeline video is unchanged",
        );
        return;
      }
      if (codexResult.exitCode !== 0 || !codexResult.final) {
        throw new Error(codexFailureMessage(codexResult));
      }
      if (workflowMode === "balanced") {
        await assertArtifactDigests(candidateRoot, creativeLocks);
        await assertArtifactDigests(candidateRoot, componentLocks);
      }

      await this.skills.verifyInstalled(candidateRoot, skillInstall.digest);
      let authoredChangedFiles = (
        await this.projects.changedFiles(candidateRoot, baseCommit)
      ).filter((path) => !path.startsWith(".agents/"));
      assertChangedPaths(authoredChangedFiles, initial.allowedPaths);
      await inspectChangedFiles(candidateRoot, authoredChangedFiles);
      let hostFinal = reconcileCodexFinalArtifacts(codexResult.final, authoredChangedFiles);
      await writeFile(
        join(runRoot, "final.json"),
        `${JSON.stringify(hostFinal, null, 2)}\n`,
        "utf8",
      );
      receipt = await this.runs.update(jobId, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        final: hostFinal,
      }));
      let usedSkills = verifyReportedSkills(
        hostFinal.skillsUsed,
        skillInstall.names,
        skillInstall.requiredSkills,
      );
      let authoredSequence: SequenceArtifactV1 | null = null;
      if (request.kind === "revision") {
        authoredSequence = await readSequenceArtifact(candidateRoot);
        assertSemanticRevisionContained(baseSequence!, authoredSequence!, request.revision!);
      } else {
        let previousContractFailure: string | null = null;
        for (let contractAttempt = 0; ; contractAttempt += 1) {
          try {
            const designTokenRepair = await repairUnusedDesignTokenBindings(candidateRoot);
            if (designTokenRepair.changedFiles.length > 0) {
              authoredChangedFiles = (
                await this.projects.changedFiles(candidateRoot, baseCommit)
              ).filter((path) => !path.startsWith(".agents/"));
              assertChangedPaths(authoredChangedFiles, initial.allowedPaths);
              await inspectChangedFiles(candidateRoot, authoredChangedFiles);
              hostFinal = reconcileCodexFinalArtifacts(hostFinal, authoredChangedFiles);
              await writeFile(
                join(runRoot, "final.json"),
                `${JSON.stringify(hostFinal, null, 2)}\n`,
                "utf8",
              );
              receipt = await this.runs.update(jobId, (current) => ({
                ...current,
                updatedAt: new Date().toISOString(),
                final: hostFinal,
              }));
              await this.event(
                receipt,
                "authoring",
                `Host rebound ${designTokenRepair.repaired.length} exact palette literal${designTokenRepair.repaired.length === 1 ? "" : "s"} to the authored design variables without changing pixels`,
                { tool: "filesystem" },
              );
            }
          } catch {
            // Parse/path errors are preserved for the aggregated validator and
            // the same-thread contract repair; deterministic normalization
            // must never replace the authoritative contract failure packet.
          }
          const componentCanonicalization =
            workflowMode === "balanced" && componentSpecialist
              ? null
              : await canonicalizeComponentPlanStateClaims(candidateRoot);
          if (componentCanonicalization?.changed) {
            authoredChangedFiles = (
              await this.projects.changedFiles(candidateRoot, baseCommit)
            ).filter((path) => !path.startsWith(".agents/"));
            assertChangedPaths(authoredChangedFiles, initial.allowedPaths);
            await inspectChangedFiles(candidateRoot, authoredChangedFiles);
            hostFinal = reconcileCodexFinalArtifacts(hostFinal, authoredChangedFiles);
            await writeFile(
              join(runRoot, "final.json"),
              `${JSON.stringify(hostFinal, null, 2)}\n`,
              "utf8",
            );
            receipt = await this.runs.update(jobId, (current) => ({
              ...current,
              updatedAt: new Date().toISOString(),
              final: hostFinal,
            }));
            await this.event(
              receipt,
              "authoring",
              `Host reconciled ${componentCanonicalization.removedStates.reduce((total, entry) => total + entry.stateIds.length, 0)} unimplemented component-state claim${componentCanonicalization.removedStates.reduce((total, entry) => total + entry.stateIds.length, 0) === 1 ? "" : "s"} to the authored DOM before contract validation`,
              { tool: "filesystem" },
            );
          }
          const containmentNormalization = await normalizeComponentPlanContainment(candidateRoot);
          if (containmentNormalization.changed) {
            authoredChangedFiles = (
              await this.projects.changedFiles(candidateRoot, baseCommit)
            ).filter((path) => !path.startsWith(".agents/"));
            assertChangedPaths(authoredChangedFiles, initial.allowedPaths);
            await inspectChangedFiles(candidateRoot, authoredChangedFiles);
            hostFinal = reconcileCodexFinalArtifacts(hostFinal, authoredChangedFiles);
            await writeFile(
              join(runRoot, "final.json"),
              `${JSON.stringify(hostFinal, null, 2)}\n`,
              "utf8",
            );
            receipt = await this.runs.update(jobId, (current) => ({
              ...current,
              updatedAt: new Date().toISOString(),
              final: hostFinal,
            }));
            await this.event(
              receipt,
              "authoring",
              `Host moved ${containmentNormalization.movedParts.length} unambiguous component part${containmentNormalization.movedParts.length === 1 ? "" : "s"} under the declared DOM owner before contract validation`,
              { tool: "filesystem" },
            );
          }
          const referenceBindingNormalization =
            await normalizeComponentPlanReferenceBindings(candidateRoot);
          if (referenceBindingNormalization.changed) {
            authoredChangedFiles = (
              await this.projects.changedFiles(candidateRoot, baseCommit)
            ).filter((path) => !path.startsWith(".agents/"));
            assertChangedPaths(authoredChangedFiles, initial.allowedPaths);
            await inspectChangedFiles(candidateRoot, authoredChangedFiles);
            hostFinal = reconcileCodexFinalArtifacts(hostFinal, authoredChangedFiles);
            await writeFile(
              join(runRoot, "final.json"),
              `${JSON.stringify(hostFinal, null, 2)}\n`,
              "utf8",
            );
            receipt = await this.runs.update(jobId, (current) => ({
              ...current,
              updatedAt: new Date().toISOString(),
              final: hostFinal,
            }));
            await this.event(
              receipt,
              "authoring",
              `Host reconciled ${referenceBindingNormalization.normalizedBindings.length} unambiguous reference-beat annotation${referenceBindingNormalization.normalizedBindings.length === 1 ? "" : "s"} to the locked component plan before contract validation`,
              { tool: "filesystem" },
            );
          }
          try {
            authoredSequence = await validateFreshBuildContract({
              candidateRoot,
              authoredChangedFiles,
              imageInputs,
              audioDirector: this.audio,
              onMotionSelectorMissing: recordMotionSelectorMissing,
            });
            break;
          } catch (contractError) {
            const contractFailure = errorMessage(contractError);
            if (contractFailure === previousContractFailure) {
              throw new Error(
                `Fresh-build contract repair made no objective progress; the same failure packet remained after ${contractAttempt} repair turn${contractAttempt === 1 ? "" : "s"}:\n${contractFailure}`,
              );
            }
            previousContractFailure = contractFailure;
            if (contractAttempt >= MAX_CONTRACT_REPAIR_ATTEMPTS) throw contractError;
            const repairNumber = contractAttempt + 1;
            await this.event(
              receipt,
              "authoring",
              `Host contract validation found a repairable mismatch; the compositor is correcting it on the same thread (${repairNumber}/${MAX_CONTRACT_REPAIR_ATTEMPTS})`,
              { tool: "contract-repair" },
            );
            const checkpoint = await captureCandidateCheckpoint(candidateRoot);
            const turnDirectory = `turns/contract-repair-${repairNumber}`;
            const contractRepairAllowedPaths =
              workflowMode === "balanced"
                ? compositorStagePaths(componentSpecialist)
                : initial.allowedPaths;
            const repairResult = await this.runCodexTurn({
              jobId,
              kind: initial.kind,
              prompt: freshContractRepairPrompt(
                contractFailure,
                repairNumber,
                MAX_CONTRACT_REPAIR_ATTEMPTS,
                workflowMode === "balanced" ? "compositor" : "Luna director",
              ),
              baseCommit,
              candidateRoot,
              runRoot,
              allowedPaths: contractRepairAllowedPaths,
              // Contract repair is still part of the original authoring job;
              // preserve the website's exact ordered image evidence so the
              // design/component contracts cannot drift to synthetic mode.
              imagePaths,
              skillProfile: skillInstall.catalog,
              authorContext: contextResult.context,
              threadId: codexResult.threadId,
              operation: "contract_repair",
              agentRole: primaryRole,
              model: primaryRoute.model,
              reasoningEffort: primaryRoute.reasoningEffort,
              workflowHandoff:
                workflowMode === "balanced"
                  ? { creativeLocked: true, componentPlanLocked: componentSpecialist }
                  : undefined,
              artifactDirectory: turnDirectory,
              onProgress: (progress) => this.codexProgress(jobId, progress),
            });
            if (
              repairResult.cancelled ||
              (!repairResult.diskComplete &&
                (repairResult.timedOut || repairResult.exitCode !== 0 || !repairResult.final))
            ) {
              throw new Error(codexFailureMessage(repairResult));
            }
            if (!repairResult.resumed || repairResult.threadId !== codexResult.threadId) {
              throw new Error("Contract repair did not resume the exact owning thread");
            }
            await this.skills.verifyInstalled(candidateRoot, skillInstall.digest);
            let changedDuringTurn = await this.restoreOutOfScopeTurnChanges({
              jobId,
              stage: "authoring",
              actor: "contract repair",
              checkpoint,
              allowedPaths: contractRepairAllowedPaths,
            });
            if (changedDuringTurn.length === 0) {
              throw new Error("Contract repair ended without changing any project files");
            }
            assertChangedPaths(changedDuringTurn, contractRepairAllowedPaths);
            await inspectChangedFiles(candidateRoot, changedDuringTurn);
            if (workflowMode === "balanced") {
              await assertArtifactDigests(candidateRoot, creativeLocks);
              await assertArtifactDigests(candidateRoot, componentLocks);
            }
            const repairSkillsUsed = repairResult.final
              ? verifyReportedSkills(
                  repairResult.final.skillsUsed,
                  skillInstall.names,
                  skillInstall.requiredSkills,
                )
              : [];
            usedSkills = [...new Set([...usedSkills, ...repairSkillsUsed])].sort();
            authoredChangedFiles = (
              await this.projects.changedFiles(candidateRoot, baseCommit)
            ).filter((path) => !path.startsWith(".agents/"));
            assertChangedPaths(authoredChangedFiles, initial.allowedPaths);
            await inspectChangedFiles(candidateRoot, authoredChangedFiles);
            hostFinal = reconcileCodexFinalArtifacts(
              repairResult.final ?? hostFinal,
              authoredChangedFiles,
            );
            if (repairResult.diskComplete && !repairResult.final) {
              await this.event(
                await this.runs.get(jobId),
                "authoring",
                "Contract repair accepted from changed disk artifacts; rerunning the authoritative packet",
                { tool: "workflow-disk-truth" },
              );
            }
            await writeFile(
              join(runRoot, turnDirectory, "final.json"),
              `${JSON.stringify(hostFinal, null, 2)}\n`,
              "utf8",
            );
            await writeFile(
              join(runRoot, "final.json"),
              `${JSON.stringify(hostFinal, null, 2)}\n`,
              "utf8",
            );
            receipt = await this.runs.update(jobId, (current) => ({
              ...current,
              updatedAt: new Date().toISOString(),
              final: hostFinal,
            }));
          }
        }
      }

      if (workflowMode === "balanced") {
        await assertArtifactDigests(candidateRoot, creativeLocks);
        await assertArtifactDigests(candidateRoot, componentLocks);
      }

      await this.skills.removeInstalled(candidateRoot);
      skillsInstalled = false;
      await ensurePlayerRuntime(candidateRoot);
      if (request.kind === "build") {
        await normalizeFreshCompositionRoots(candidateRoot, authoredSequence!);
        await ensureFreshClipClasses(candidateRoot);
        await normalizeFreshClipTracks(candidateRoot);
        await scopeFreshGsapSelectors(candidateRoot);
        await normalizeFreshCompositionSelfSelectors(candidateRoot);
        await normalizeFreshFontFallbacks(candidateRoot);
        await normalizeReadablePointerEvents(candidateRoot);
        await ensureFreshGsapTargets(candidateRoot);
        await normalizeFreshGsapLifecycle(candidateRoot);
        await repairFreshGsapTransformConflicts(candidateRoot);
      }
      await normalizeRootAssetPaths(candidateRoot, authoredChangedFiles);
      const hostVerifiedChangedFiles = await this.projects.changedFiles(candidateRoot, baseCommit);
      assertChangedPaths(hostVerifiedChangedFiles, initial.allowedPaths);
      await inspectChangedFiles(candidateRoot, hostVerifiedChangedFiles);
      receipt = await this.runs.transition(jobId, "verifying", {
        final: hostFinal,
        skillsUsed: usedSkills,
        changedFiles: hostVerifiedChangedFiles,
      });
      await this.event(
        receipt,
        "verifying",
        "Host is running pinned Hyperframes lint and the full browser check",
      );
      let qaAttempt = 1;
      let qaArtifact = `qa/attempt-${qaAttempt}/qa.json`;
      let qa = await this.hyperframes.verify(jobId, candidateRoot, runRoot, {
        artifactDirectory: `qa/attempt-${qaAttempt}`,
        sequence: authoredSequence!,
      });
      const qaRemediations: NonNullable<RunReceiptV1["qaRemediations"]> = [];
      ({ qa, qaAttempt, qaArtifact } = await this.remediateQaCategories({
        jobId,
        candidateRoot,
        runRoot,
        sequence: authoredSequence!,
        allowedPaths: initial.allowedPaths,
        receipt,
        qaRemediations,
        qa,
        qaAttempt,
        qaArtifact,
        maxQaAttempt: 4,
      }));
      const layoutRepairs: NonNullable<RunReceiptV1["layoutRepairs"]> = [];
      let priorLayoutRepairFeedback: LayoutRepairFeedback | null = null;
      for (
        let repairIndex = 1;
        !qa.ok && hasLayoutRepairBudget(repairIndex, qaAttempt);
        repairIndex += 1
      ) {
        const unresolved = unresolvedLayoutClusters(qa);
        const repairClusters = layoutRepairClusterBatch(unresolved);
        const cluster = repairClusters[0];
        if (!cluster) break;
        const inputLayoutQaArtifact = qaArtifact;
        const beforeUnresolvedClusters = unresolved.length;
        const beforeLayoutFindings = unresolvedLayoutFindingCount(qa);
        const beforeOwnedMotion = authorOwnedMotionFindingCount(qa);
        const beforeOther = actionableUnownedNonDeterministicNonLayoutCount(qa);
        const currentSequence = (await readSequenceArtifact(candidateRoot))!;
        const repairFindings = mergeQaRepairFindings(
          findingsForLayoutClusters(qa, repairClusters),
          priorLayoutRepairFeedback?.findings.filter(isAuthorOwnedMotionFinding) ?? [],
        ).slice(0, 30);
        const repairAllowedPaths = layoutRepairAllowedPaths(
          cluster,
          repairFindings,
          workflowMode === "balanced"
            ? compositorStagePaths(componentSpecialist)
            : initial.allowedPaths,
        );
        const layoutInspection = await optionalLayoutInspection(runRoot, cluster);
        const evidenceImages: string[] = [];
        const evidenceImagePaths: string[] = [];
        for (const evidenceCluster of repairClusters.slice(0, 2)) {
          const evidence = await layoutRepairEvidence(runRoot, qaArtifact, evidenceCluster);
          for (let index = 0; index < evidence.evidenceImages.length; index += 1) {
            const artifact = evidence.evidenceImages[index]!;
            if (evidenceImages.includes(artifact) || evidenceImages.length >= 4) continue;
            evidenceImages.push(artifact);
            evidenceImagePaths.push(evidence.evidenceImagePaths[index]!);
          }
        }
        const turnDirectory = `turns/layout-repair-${repairIndex}`;
        const repairContext = await this.contexts.prepare({
          runRoot,
          acceptedCommit: baseCommit,
          skills: skillInstall.catalog,
          prompt: request.prompt,
          sequence: currentSequence,
          revisionScope: request.revision ?? null,
          qaFindings: repairFindings,
          layoutInspection,
          artifactDirectory: turnDirectory,
        });
        const checkpoint = await captureCandidateCheckpoint(candidateRoot);
        const baselineRoot = join(runRoot, "layout-repair", `attempt-${repairIndex}`, "baseline");
        await mkdir(join(runRoot, "layout-repair", `attempt-${repairIndex}`), {
          recursive: true,
        });
        await cp(candidateRoot, baselineRoot, {
          recursive: true,
          force: false,
          errorOnExist: true,
          filter: (source) =>
            ![".git", ".agents", ".env"].includes(source.split(/[\\/]/).at(-1) ?? ""),
        });

        let changedDuringTurn: string[] = [];
        let outputQaArtifact: string | null = null;
        let candidateQa: QaReceiptV1 | null = null;
        let proofComparison: RunReceiptV1["proofComparison"] = null;
        let repairFinal: NonNullable<RunReceiptV1["final"]> | null = null;
        let afterUnresolvedClusters: number | null = null;
        let attemptError: string | null = null;
        let adopted = false;
        try {
          const repairSkillInstall = await this.skills.install(candidateRoot);
          skillsInstalled = true;
          const repairResult = await this.runCodexTurn({
            jobId,
            kind: initial.kind,
            prompt: layoutRepairPrompt(repairClusters, repairIndex, priorLayoutRepairFeedback),
            baseCommit,
            candidateRoot,
            runRoot,
            allowedPaths: repairAllowedPaths,
            imagePaths: [],
            evidenceImagePaths,
            skillProfile: repairSkillInstall.catalog,
            authorContext: repairContext.context,
            threadId: codexResult.threadId,
            operation: "layout_repair",
            agentRole: primaryRole,
            model: primaryRoute.model,
            reasoningEffort: primaryRoute.reasoningEffort,
            workflowHandoff:
              workflowMode === "balanced"
                ? { creativeLocked: true, componentPlanLocked: componentSpecialist }
                : undefined,
            artifactDirectory: turnDirectory,
            onProgress: (progress) => this.codexProgress(jobId, progress),
          });
          if (
            repairResult.cancelled ||
            (!repairResult.diskComplete &&
              (repairResult.timedOut || repairResult.exitCode !== 0 || !repairResult.final))
          ) {
            throw new Error(codexFailureMessage(repairResult));
          }
          if (!repairResult.resumed || repairResult.threadId !== codexResult.threadId) {
            throw new Error("Layout repair did not resume the exact candidate director thread");
          }
          await this.skills.verifyInstalled(candidateRoot, repairSkillInstall.digest);
          await this.skills.removeInstalled(candidateRoot);
          skillsInstalled = false;
          const repairSkillsUsed = repairResult.final
            ? verifyReportedSkills(
                repairResult.final.skillsUsed,
                repairSkillInstall.names,
                repairSkillInstall.requiredSkills,
              )
            : [];
          usedSkills = [...new Set([...usedSkills, ...repairSkillsUsed])].sort();
          changedDuringTurn = await this.restoreOutOfScopeTurnChanges({
            jobId,
            stage: "verifying",
            actor: "layout repair",
            checkpoint,
            allowedPaths: repairAllowedPaths,
          });
          assertChangedPaths(changedDuringTurn, repairAllowedPaths);
          await inspectChangedFiles(candidateRoot, changedDuringTurn);
          repairFinal = reconcileCodexFinalArtifacts(
            repairResult.final ?? hostFinal,
            changedDuringTurn,
          );
          if (repairResult.diskComplete && !repairResult.final) {
            await this.event(
              await this.runs.get(jobId),
              "verifying",
              `Focused layout repair ${repairIndex} accepted from changed disk artifacts; rerunning renderer-backed QA`,
              { tool: "workflow-disk-truth" },
            );
          }
          await normalizeRootAssetPaths(candidateRoot, changedDuringTurn);
          await writeFile(
            join(runRoot, turnDirectory, "final.json"),
            `${JSON.stringify(repairFinal, null, 2)}\n`,
            "utf8",
          );
          const repairedSequence = (await readSequenceArtifact(candidateRoot))!;
          if (request.kind === "revision") {
            assertSemanticRevisionContained(baseSequence!, repairedSequence, request.revision!);
          } else {
            if (repairedSequence.revision !== null) {
              throw new Error("A layout repair must not add revision scope to a new build");
            }
            assertLaunchSequenceSemantics(repairedSequence);
            await assertLaunchMotionSidecar(candidateRoot, repairedSequence);
            await normalizeLaunchMotionSidecarTargets(candidateRoot, repairedSequence, {
              onMotionSelectorMissing: recordMotionSelectorMissing,
            });
            await normalizeFreshCompositionRoots(candidateRoot, repairedSequence);
            await ensureFreshClipClasses(candidateRoot);
            await normalizeFreshClipTracks(candidateRoot);
            await scopeFreshGsapSelectors(candidateRoot);
            await normalizeFreshCompositionSelfSelectors(candidateRoot);
            await normalizeFreshFontFallbacks(candidateRoot);
            await normalizeReadablePointerEvents(candidateRoot);
            await ensureFreshGsapTargets(candidateRoot);
            await normalizeFreshGsapLifecycle(candidateRoot);
            await repairFreshGsapTransformConflicts(candidateRoot);
          }
          if (workflowMode === "balanced") {
            await assertArtifactDigests(candidateRoot, creativeLocks);
            await assertArtifactDigests(candidateRoot, componentLocks);
          }
          const outputQaAttempt = qaAttempt + 1;
          outputQaArtifact = `qa/attempt-${outputQaAttempt}/qa.json`;
          qaAttempt = outputQaAttempt;
          candidateQa = await this.hyperframes.verify(jobId, candidateRoot, runRoot, {
            artifactDirectory: `qa/attempt-${outputQaAttempt}`,
            sequence: repairedSequence,
          });
          afterUnresolvedClusters = unresolvedLayoutClusters(candidateQa).length;
          const afterLayoutFindings = unresolvedLayoutFindingCount(candidateQa);
          const afterOwnedMotion = authorOwnedMotionFindingCount(candidateQa);
          const afterOther = actionableUnownedNonDeterministicNonLayoutCount(candidateQa);
          const proofScope = layoutRepairProofScope(currentSequence, cluster);
          if (proofScope.unchangedProofs.length > 0) {
            proofComparison = await this.proofs.compare({
              jobId,
              baseRoot: baselineRoot,
              candidateRoot,
              runRoot,
              scope: proofScope,
              artifactDirectory: `layout-repair/attempt-${repairIndex}/proof`,
            });
          }
          const improved =
            (candidateQa.ok ||
              afterUnresolvedClusters < beforeUnresolvedClusters ||
              afterLayoutFindings < beforeLayoutFindings ||
              afterOwnedMotion < beforeOwnedMotion) &&
            afterUnresolvedClusters <= beforeUnresolvedClusters &&
            afterLayoutFindings <= beforeLayoutFindings &&
            afterOwnedMotion <= beforeOwnedMotion &&
            afterOther <= beforeOther &&
            (proofComparison?.ok ?? true);
          if (improved) {
            qa = candidateQa;
            qaArtifact = outputQaArtifact;
            adopted = true;
            priorLayoutRepairFeedback = null;
          } else {
            await checkpoint.restore();
            await writeFile(join(runRoot, "qa.json"), `${JSON.stringify(qa, null, 2)}\n`, "utf8");
            attemptError =
              proofComparison?.ok === false
                ? "Repair changed an unchanged proof frame"
                : afterOwnedMotion > beforeOwnedMotion || afterOther > beforeOther
                  ? "Repair reduced the layout cluster but regressed a non-layout QA category"
                  : "Repair did not reduce the unresolved layout cluster or owned motion findings";
            priorLayoutRepairFeedback = layoutRepairFeedback(attemptError, candidateQa);
          }
        } catch (error) {
          if (skillsInstalled) {
            await this.skills.verifyInstalled(candidateRoot, skillInstall.digest);
            await this.skills.removeInstalled(candidateRoot);
            skillsInstalled = false;
          }
          await checkpoint.restore();
          await writeFile(join(runRoot, "qa.json"), `${JSON.stringify(qa, null, 2)}\n`, "utf8");
          attemptError = errorMessage(error).slice(0, 4_000);
          priorLayoutRepairFeedback = layoutRepairFeedback(attemptError, candidateQa);
        }
        const attempt = LayoutRepairAttemptV1Schema.parse({
          version: "sequences.layout-repair-attempt.v1",
          attempt: repairIndex,
          clusterIds: repairClusters.map((repairCluster) => repairCluster.id),
          threadId: codexResult.threadId,
          resumed: true,
          inputQaArtifact: inputLayoutQaArtifact,
          outputQaArtifact,
          contextArtifact: repairContext.receipt.artifact,
          evidenceImages,
          allowedPaths: repairAllowedPaths,
          changedFiles: changedDuringTurn,
          adopted,
          beforeUnresolvedClusters,
          afterUnresolvedClusters,
          proofComparison,
          final: repairFinal,
          error: attemptError,
        });
        layoutRepairs.push(attempt);
        receipt = await this.runs.update(jobId, (current) => ({
          ...current,
          qa,
          qaRemediations,
          layoutRepairs,
          skillsUsed: usedSkills,
          updatedAt: new Date().toISOString(),
        }));
        await this.event(
          receipt,
          "verifying",
          adopted
            ? `The compositor repaired ${layoutRepairBatchSummary(repairClusters)}; QA and unchanged proof frames were rerun`
            : `Focused layout repair ${repairIndex} was rejected; the candidate was restored`,
          { tool: "layout-repair" },
        );
      }
      if (!qa.ok) {
        // A creative layout repair can expose new deterministic debt (for
        // example a contrast sample against a background it introduced), and
        // small residual categories must not kill an otherwise passing run.
        const latestSequence = await readSequenceArtifact(candidateRoot);
        ({ qa, qaAttempt, qaArtifact } = await this.remediateQaCategories({
          jobId,
          candidateRoot,
          runRoot,
          sequence: latestSequence ?? authoredSequence!,
          allowedPaths: initial.allowedPaths,
          receipt,
          qaRemediations,
          qa,
          qaAttempt,
          qaArtifact,
          maxQaAttempt: POST_LAYOUT_QA_ATTEMPT_CEILING,
        }));
      }
      // HyperFrames motion/lint failures such as motion_selector_missing,
      // motion_frozen, motion_off_frame, and gsap_non_transform_motion need a
      // creative source correction, not a deterministic string rewrite. Give
      // the exact same director at most two focused turns. Every turn starts
      // from a restorable checkpoint and is adopted only when a full strict
      // re-verify contains fewer actionable findings without any new layout
      // debt. This owns both hard errors and residual warnings.
      let rejectedMotionFindings: QaReceiptV1["findings"] = [];
      for (
        let repairIndex = 1;
        repairIndex <= 2 &&
        !qa.ok &&
        request.kind === "build" &&
        unresolvedLayoutClusters(qa).length === 0 &&
        actionableNonLayoutCount(qa) > 0 &&
        qaAttempt < FINAL_QA_ATTEMPT_CEILING;
        repairIndex += 1
      ) {
        const inputQaArtifact = qaArtifact;
        const beforeActionable = actionableFindingCount(qa);
        const beforeLayoutClusters = unresolvedLayoutClusters(qa).length;
        const beforeLayoutFindings = unresolvedLayoutFindingCount(qa);
        const repairFindings = mergeQaRepairFindings(
          rejectedMotionFindings,
          qa.findings.filter(
            (finding) =>
              finding.severity !== "info" &&
              finding.category !== "layout_inspection" &&
              !isRepairableLayoutFinding(finding),
          ),
        ).slice(0, 30);
        if (repairFindings.length === 0) break;
        const currentSequence = (await readSequenceArtifact(candidateRoot))!;
        const repairAllowedPaths = qaRepairAllowedPaths(
          repairFindings,
          currentSequence,
          workflowMode === "balanced"
            ? compositorStagePaths(componentSpecialist)
            : initial.allowedPaths,
        );
        const turnDirectory = `turns/qa-repair-${repairIndex}`;
        const repairContext = await this.contexts.prepare({
          runRoot,
          acceptedCommit: baseCommit,
          skills: skillInstall.catalog,
          prompt: request.prompt,
          sequence: currentSequence,
          revisionScope: null,
          qaFindings: repairFindings,
          artifactDirectory: turnDirectory,
        });
        // Donor lesson (Slack Sequences self-review): residual-warning fixes
        // made against rendered pixels beat fixes made against prose. Attach
        // the failing attempt's own snapshots as read-only visual evidence.
        const qaEvidence = await qaSnapshotEvidence(runRoot, inputQaArtifact);
        const checkpoint = await captureCandidateCheckpoint(candidateRoot);
        let adopted = false;
        let repairError: string | null = null;
        try {
          const repairSkillInstall = await this.skills.install(candidateRoot);
          skillsInstalled = true;
          const repairResult = await this.runCodexTurn({
            jobId,
            kind: initial.kind,
            prompt: qaRepairPrompt(
              repairFindings,
              repairIndex,
              request.prompt,
              imagePaths,
              qaEvidence.evidenceImages.length,
            ),
            baseCommit,
            candidateRoot,
            runRoot,
            allowedPaths: repairAllowedPaths,
            // Repair is part of the original website request. Preserve the
            // exact ordered references so brand/product semantics cannot
            // silently drift to synthetic mode on a resumed turn.
            imagePaths,
            evidenceImagePaths: qaEvidence.evidenceImagePaths,
            skillProfile: repairSkillInstall.catalog,
            authorContext: repairContext.context,
            threadId: codexResult.threadId,
            operation: "qa_repair",
            agentRole: primaryRole,
            model: primaryRoute.model,
            reasoningEffort: primaryRoute.reasoningEffort,
            workflowHandoff:
              workflowMode === "balanced"
                ? { creativeLocked: true, componentPlanLocked: componentSpecialist }
                : undefined,
            artifactDirectory: turnDirectory,
            onProgress: (progress) => this.codexProgress(jobId, progress),
          });
          if (
            repairResult.cancelled ||
            (!repairResult.diskComplete &&
              (repairResult.timedOut || repairResult.exitCode !== 0 || !repairResult.final))
          ) {
            throw new Error(codexFailureMessage(repairResult));
          }
          if (!repairResult.resumed || repairResult.threadId !== codexResult.threadId) {
            throw new Error("QA repair did not resume the exact owning thread");
          }
          await this.skills.verifyInstalled(candidateRoot, repairSkillInstall.digest);
          await this.skills.removeInstalled(candidateRoot);
          skillsInstalled = false;
          const repairSkillsUsed = repairResult.final
            ? verifyReportedSkills(
                repairResult.final.skillsUsed,
                repairSkillInstall.names,
                repairSkillInstall.requiredSkills,
              )
            : [];
          usedSkills = [...new Set([...usedSkills, ...repairSkillsUsed])].sort();
          let changedDuringTurn = await this.restoreOutOfScopeTurnChanges({
            jobId,
            stage: "verifying",
            actor: "QA repair",
            checkpoint,
            allowedPaths: repairAllowedPaths,
          });
          if (changedDuringTurn.length === 0) {
            throw new Error("The focused QA repair ended without changing any project files");
          }
          assertChangedPaths(changedDuringTurn, repairAllowedPaths);
          await inspectChangedFiles(candidateRoot, changedDuringTurn);
          const repairedSequence = (await readSequenceArtifact(candidateRoot))!;
          if (repairedSequence.revision !== null) {
            throw new Error("A focused QA repair must not add revision scope to a new build");
          }
          assertLaunchSequenceSemantics(repairedSequence);
          await assertLaunchMotionSidecar(candidateRoot, repairedSequence);
          await normalizeLaunchMotionSidecarTargets(candidateRoot, repairedSequence, {
            onMotionSelectorMissing: recordMotionSelectorMissing,
          });
          await normalizeFreshCompositionRoots(candidateRoot, repairedSequence);
          await ensureFreshClipClasses(candidateRoot);
          await normalizeFreshClipTracks(candidateRoot);
          await scopeFreshGsapSelectors(candidateRoot);
          await normalizeFreshCompositionSelfSelectors(candidateRoot);
          await normalizeFreshFontFallbacks(candidateRoot);
          await normalizeReadablePointerEvents(candidateRoot);
          await ensureFreshGsapTargets(candidateRoot);
          await normalizeFreshGsapLifecycle(candidateRoot);
          await repairFreshGsapTransformConflicts(candidateRoot);
          await normalizeRootAssetPaths(candidateRoot, changedDuringTurn);
          if (workflowMode === "balanced") {
            await assertArtifactDigests(candidateRoot, creativeLocks);
            await assertArtifactDigests(candidateRoot, componentLocks);
          }
          // Host normalization is part of the same transaction. Recompute the
          // disk diff so scope enforcement and the durable repair ledger cover
          // every byte that will be verified and potentially adopted.
          changedDuringTurn = await checkpoint.changedPaths();
          assertChangedPaths(changedDuringTurn, repairAllowedPaths);
          await inspectChangedFiles(candidateRoot, changedDuringTurn);
          const repairFinal = reconcileCodexFinalArtifacts(
            repairResult.final ?? hostFinal,
            changedDuringTurn,
          );
          if (repairResult.diskComplete && !repairResult.final) {
            await this.event(
              await this.runs.get(jobId),
              "verifying",
              `Focused QA repair ${repairIndex}/2 accepted from changed disk artifacts; rerunning strict QA`,
              { tool: "workflow-disk-truth" },
            );
          }
          await writeFile(
            join(runRoot, turnDirectory, "final.json"),
            `${JSON.stringify(repairFinal, null, 2)}\n`,
            "utf8",
          );
          const outputQaAttempt = qaAttempt + 1;
          const outputQaArtifact = `qa/attempt-${outputQaAttempt}/qa.json`;
          qaAttempt = outputQaAttempt;
          const candidateQa = await this.hyperframes.verify(jobId, candidateRoot, runRoot, {
            artifactDirectory: `qa/attempt-${outputQaAttempt}`,
            sequence: repairedSequence,
          });
          const afterActionable = actionableFindingCount(candidateQa);
          const afterLayoutClusters = unresolvedLayoutClusters(candidateQa).length;
          const afterLayoutFindings = unresolvedLayoutFindingCount(candidateQa);
          const improved =
            afterActionable < beforeActionable &&
            afterLayoutClusters <= beforeLayoutClusters &&
            afterLayoutFindings <= beforeLayoutFindings;
          if (improved) {
            qaRemediations.push(
              QaRemediationV1Schema.parse({
                version: "sequences.qa-remediation.v1",
                category: "author_polish",
                fixerVersion: "sequences.author-polish.v1",
                pass:
                  qaRemediations.filter((entry) => entry.category === "author_polish").length + 1,
                inputArtifact: inputQaArtifact,
                outputArtifact: outputQaArtifact,
                threadId: codexResult.threadId,
                evidenceImages: qaEvidence.evidenceImages,
                repaired: changedDuringTurn.map((sourceFile) => ({ sourceFile })),
              }),
            );
            qa = candidateQa;
            qaArtifact = outputQaArtifact;
            rejectedMotionFindings = [];
            adopted = true;
          } else {
            rejectedMotionFindings = mergeQaRepairFindings(
              rejectedMotionFindings,
              candidateQa.findings.filter(isAuthorOwnedMotionFinding),
            );
            await checkpoint.restore();
            await writeFile(join(runRoot, "qa.json"), `${JSON.stringify(qa, null, 2)}\n`, "utf8");
            repairError =
              afterLayoutClusters > beforeLayoutClusters ||
              afterLayoutFindings > beforeLayoutFindings
                ? "The focused QA repair introduced a layout regression"
                : "The focused QA repair did not strictly reduce actionable findings";
          }
        } catch (error) {
          if (skillsInstalled) {
            await this.skills.verifyInstalled(candidateRoot, skillInstall.digest);
            await this.skills.removeInstalled(candidateRoot);
            skillsInstalled = false;
          }
          await checkpoint.restore();
          await writeFile(join(runRoot, "qa.json"), `${JSON.stringify(qa, null, 2)}\n`, "utf8");
          repairError = errorMessage(error).slice(0, 4_000);
        }
        await this.event(
          receipt,
          "verifying",
          adopted
            ? `The compositor reduced the residual HyperFrames QA findings on the same run (${repairIndex}/2); strict QA was rerun on the complete candidate`
            : `Focused QA repair ${repairIndex}/2 was rejected; the candidate was restored${repairError ? ` (${repairError.slice(0, 200)})` : ""}`,
          { tool: "author-qa-repair" },
        );
      }

      if (workflowMode === "balanced" && qa.ok && request.kind === "build") {
        const auditSequence = (await readSequenceArtifact(candidateRoot))!;
        let auditCaptureError: string | null = null;
        let auditEvidence: {
          evidenceImages: string[];
          evidenceImagePaths: string[];
          times: number[];
        };
        try {
          auditEvidence = await this.hyperframes.captureTemporalSnapshots(
            jobId,
            candidateRoot,
            runRoot,
            temporalEvidenceSnapshotTimes(auditSequence),
          );
        } catch (error) {
          auditCaptureError = errorMessage(error).slice(0, 1_000);
          auditEvidence = { evidenceImages: [], evidenceImagePaths: [], times: [] };
        }
        if (auditEvidence.evidenceImages.length === 0) {
          await this.event(
            receipt,
            "verifying",
            auditCaptureError
              ? `Visual audit skipped because exact temporal capture failed; deterministic QA remains authoritative (${auditCaptureError.slice(0, 200)})`
              : "Visual audit skipped because exact temporal capture produced no rendered evidence",
            { tool: "visual-audit" },
          );
        } else {
          const temporalEvidence = await createTemporalEvidence(
            runRoot,
            auditSequence,
            qaArtifact,
            auditEvidence.evidenceImages,
          );
          const auditContext = await this.contexts.prepare({
            runRoot,
            acceptedCommit: baseCommit,
            skills: skillInstall.catalog,
            prompt: request.prompt,
            sequence: auditSequence,
            revisionScope: null,
            qaFindings: qa.findings,
            artifactDirectory: "turns/workflow-visual-audit",
          });
          const auditRoute = resolveAgentRoute(this.config, "visual_auditor");
          await this.event(
            receipt,
            "verifying",
            `${auditRoute.model}/${auditRoute.reasoningEffort} is auditing the temporal story, camera, placement, and motion landings`,
            { tool: "visual-audit" },
          );
          const auditCheckpoint = await captureCandidateCheckpoint(candidateRoot);
          const auditResult = await this.runCodexTurn({
            jobId,
            kind: "build",
            prompt: request.prompt,
            baseCommit,
            candidateRoot,
            runRoot,
            allowedPaths: [],
            imagePaths,
            evidenceImagePaths: auditEvidence.evidenceImagePaths,
            skillProfile: skillInstall.catalog,
            authorContext: auditContext.context,
            threadId: null,
            operation: "visual_audit",
            agentRole: "visual_auditor",
            model: auditRoute.model,
            reasoningEffort: auditRoute.reasoningEffort,
            responseKind: "visual_audit",
            temporalEvidence,
            artifactDirectory: "turns/workflow-visual-audit",
            onProgress: (progress) => this.codexProgress(jobId, progress),
          });
          const auditMutations = await auditCheckpoint.changedPaths();
          if (auditMutations.length > 0) {
            await auditCheckpoint.restore();
            await this.event(
              receipt,
              "verifying",
              "Visual audit was discarded because the read-only auditor changed candidate files; the verified candidate was restored",
              { tool: "visual-audit" },
            );
          } else if (
            auditResult.cancelled ||
            auditResult.timedOut ||
            auditResult.exitCode !== 0 ||
            !auditResult.audit
          ) {
            await this.event(
              receipt,
              "verifying",
              "Visual audit did not return a valid report; deterministic QA remains authoritative",
              { tool: "visual-audit" },
            );
          } else {
            let auditReport: NonNullable<RunReceiptV1["visualAudit"]> | null = auditResult.audit;
            try {
              assertVisualAuditBindings(auditReport, temporalEvidence, auditSequence);
            } catch (error) {
              await this.event(
                receipt,
                "verifying",
                `Visual audit was discarded because its evidence bindings were invalid; deterministic QA remains authoritative (${errorMessage(error).slice(0, 200)})`,
                { tool: "visual-audit" },
              );
              auditReport = null;
            }
            if (auditReport) {
              await writeFile(
                join(runRoot, "workflow", "visual-audit.json"),
                `${JSON.stringify(auditReport, null, 2)}\n`,
                { encoding: "utf8", mode: 0o600 },
              );
              receipt = await this.runs.update(jobId, (current) => ({
                ...current,
                visualAudit: auditReport,
                agentWorkflow: {
                  ...current.agentWorkflow,
                  temporalEvidenceArtifact: "workflow/temporal-evidence.json",
                  visualAuditArtifact: "workflow/visual-audit.json",
                },
                updatedAt: new Date().toISOString(),
              }));

              const auditRequestedPolish =
                auditReport.verdict === "repair" && auditReport.findings.length > 0;
              const auditPolishSlotAvailable = qaAttempt < 9;
              if (auditRequestedPolish && auditPolishSlotAvailable) {
                const polishCheckpoint = await captureCandidateCheckpoint(candidateRoot);
                let polishAdopted = false;
                let polishError: string | null = null;
                try {
                  const polishSkillInstall = await this.skills.install(candidateRoot);
                  skillsInstalled = true;
                  const polishContext = await this.contexts.prepare({
                    runRoot,
                    acceptedCommit: baseCommit,
                    skills: polishSkillInstall.catalog,
                    prompt: request.prompt,
                    sequence: auditSequence,
                    revisionScope: null,
                    qaFindings: auditReport.findings,
                    artifactDirectory: "turns/workflow-audit-polish",
                  });
                  const polishResult = await this.runCodexTurn({
                    jobId,
                    kind: "build",
                    prompt: auditPolishPrompt(auditReport, request.prompt),
                    baseCommit,
                    candidateRoot,
                    runRoot,
                    allowedPaths: compositorStagePaths(componentSpecialist),
                    imagePaths,
                    evidenceImagePaths: auditEvidence.evidenceImagePaths,
                    skillProfile: polishSkillInstall.catalog,
                    authorContext: polishContext.context,
                    threadId: codexResult.threadId,
                    operation: "audit_polish",
                    agentRole: primaryRole,
                    model: primaryRoute.model,
                    reasoningEffort: primaryRoute.reasoningEffort,
                    workflowHandoff: {
                      creativeLocked: true,
                      componentPlanLocked: componentSpecialist,
                    },
                    temporalEvidence,
                    artifactDirectory: "turns/workflow-audit-polish",
                    onProgress: (progress) => this.codexProgress(jobId, progress),
                  });
                  if (
                    polishResult.cancelled ||
                    (!polishResult.diskComplete &&
                      (polishResult.timedOut || polishResult.exitCode !== 0 || !polishResult.final))
                  ) {
                    throw new Error(codexFailureMessage(polishResult));
                  }
                  if (!polishResult.resumed || polishResult.threadId !== codexResult.threadId) {
                    throw new Error("Audit polish did not resume the exact compositor thread");
                  }
                  await this.skills.verifyInstalled(candidateRoot, polishSkillInstall.digest);
                  await this.skills.removeInstalled(candidateRoot);
                  skillsInstalled = false;
                  let polishChanges = await this.restoreOutOfScopeTurnChanges({
                    jobId,
                    stage: "verifying",
                    actor: "visual-audit polish",
                    checkpoint: polishCheckpoint,
                    allowedPaths: compositorStagePaths(componentSpecialist),
                  });
                  if (polishChanges.length === 0) {
                    throw new Error("Audit polish ended without changing any renderable source");
                  }
                  assertChangedPaths(polishChanges, compositorStagePaths(componentSpecialist));
                  await inspectChangedFiles(candidateRoot, polishChanges);
                  await assertArtifactDigests(candidateRoot, creativeLocks);
                  await assertArtifactDigests(candidateRoot, componentLocks);
                  const allPolishedChanges = (
                    await this.projects.changedFiles(candidateRoot, baseCommit)
                  ).filter((path) => !path.startsWith(".agents/"));
                  const polishedSequence = await validateFreshBuildContract({
                    candidateRoot,
                    authoredChangedFiles: allPolishedChanges,
                    imageInputs,
                    audioDirector: this.audio,
                    onMotionSelectorMissing: recordMotionSelectorMissing,
                  });
                  await normalizeLaunchMotionSidecarTargets(candidateRoot, polishedSequence, {
                    onMotionSelectorMissing: recordMotionSelectorMissing,
                  });
                  await normalizeFreshCompositionRoots(candidateRoot, polishedSequence);
                  await ensureFreshClipClasses(candidateRoot);
                  await normalizeFreshClipTracks(candidateRoot);
                  await scopeFreshGsapSelectors(candidateRoot);
                  await normalizeFreshCompositionSelfSelectors(candidateRoot);
                  await normalizeFreshFontFallbacks(candidateRoot);
                  await normalizeReadablePointerEvents(candidateRoot);
                  await ensureFreshGsapTargets(candidateRoot);
                  await normalizeFreshGsapLifecycle(candidateRoot);
                  await repairFreshGsapTransformConflicts(candidateRoot);
                  polishChanges = await polishCheckpoint.changedPaths();
                  assertChangedPaths(polishChanges, compositorStagePaths(componentSpecialist));
                  await inspectChangedFiles(candidateRoot, polishChanges);
                  await assertArtifactDigests(candidateRoot, creativeLocks);
                  await assertArtifactDigests(candidateRoot, componentLocks);
                  if (polishResult.diskComplete && !polishResult.final) {
                    await this.event(
                      await this.runs.get(jobId),
                      "verifying",
                      "Visual-audit polish accepted from changed disk artifacts; rerunning the full strict gate",
                      { tool: "workflow-disk-truth" },
                    );
                  }
                  const polishQaAttempt = qaAttempt + 1;
                  if (polishQaAttempt > 9) {
                    throw new Error("No bounded QA artifact slot remains for visual-audit polish");
                  }
                  const polishedQa = await this.hyperframes.verify(jobId, candidateRoot, runRoot, {
                    artifactDirectory: `qa/attempt-${polishQaAttempt}`,
                    sequence: polishedSequence,
                  });
                  if (!polishedQa.ok) {
                    throw new Error("Audit polish failed the full strict HyperFrames gate");
                  }
                  const polishSkillsUsed = polishResult.final
                    ? verifyReportedSkills(
                        polishResult.final.skillsUsed,
                        polishSkillInstall.names,
                        polishSkillInstall.requiredSkills,
                      )
                    : [];
                  usedSkills = [...new Set([...usedSkills, ...polishSkillsUsed])].sort();
                  qaAttempt = polishQaAttempt;
                  qaArtifact = `qa/attempt-${polishQaAttempt}/qa.json`;
                  qa = polishedQa;
                  authoredSequence = polishedSequence;
                  hostFinal = reconcileCodexFinalArtifacts(
                    polishResult.final ?? hostFinal,
                    await this.projects.changedFiles(candidateRoot, baseCommit),
                  );
                  await writeFile(
                    join(runRoot, "turns", "workflow-audit-polish", "final.json"),
                    `${JSON.stringify(hostFinal, null, 2)}\n`,
                    "utf8",
                  );
                  await writeFile(
                    join(runRoot, "final.json"),
                    `${JSON.stringify(hostFinal, null, 2)}\n`,
                    "utf8",
                  );
                  polishAdopted = true;
                } catch (error) {
                  if (skillsInstalled) {
                    await this.skills.removeInstalled(candidateRoot);
                    skillsInstalled = false;
                  }
                  await polishCheckpoint.restore();
                  await writeFile(
                    join(runRoot, "qa.json"),
                    `${JSON.stringify(qa, null, 2)}\n`,
                    "utf8",
                  );
                  polishError = errorMessage(error).slice(0, 4_000);
                }
                await this.event(
                  receipt,
                  "verifying",
                  polishAdopted
                    ? "The compositor applied the bounded visual-audit improvement and the complete strict QA gate passed again"
                    : `Visual-audit polish was rejected and the verified candidate was restored${polishError ? ` (${polishError.slice(0, 200)})` : ""}`,
                  { tool: "audit-polish" },
                );
              }
              if (auditRequestedPolish && !auditPolishSlotAvailable) {
                await this.event(
                  receipt,
                  "verifying",
                  "Visual audit requested a polish, but the bounded QA ledger had no remaining attempt; the verified candidate was preserved",
                  { tool: "audit-polish" },
                );
              }
            }
          }
        }
      }
      qa = withMotionSelectorMissingNormalizations(qa, [
        ...motionSelectorMissingNormalizations.values(),
      ]);
      await writeFile(join(runRoot, "qa.json"), `${JSON.stringify(qa, null, 2)}\n`, "utf8");
      const changedFiles = await this.projects.changedFiles(candidateRoot, baseCommit);
      assertChangedPaths(changedFiles, initial.allowedPaths);
      await inspectChangedFiles(candidateRoot, changedFiles);
      receipt = await this.runs.update(jobId, (current) => ({
        ...current,
        qa,
        qaRemediations,
        layoutRepairs,
        skillsUsed: usedSkills,
        changedFiles,
        final: hostFinal,
        updatedAt: new Date().toISOString(),
      }));
      if (receipt.state === "cancelled") return;
      if (!qa.ok) throw new Error("Pinned Hyperframes lint/check gates did not pass");
      const unchangedAfterQa = await this.projects.changedFiles(candidateRoot, baseCommit);
      if (JSON.stringify(unchangedAfterQa) !== JSON.stringify(changedFiles)) {
        throw new Error("Host QA unexpectedly changed candidate creative source");
      }

      if (request.kind === "build") {
        const finalSequence = (await readSequenceArtifact(candidateRoot))!;
        assertLaunchSequenceSemantics(finalSequence);
        await assertFreshBuildAuthored(candidateRoot, finalSequence, changedFiles);
        const designCapsule = await assertDesignCapsule(candidateRoot, imageInputs);
        await assertComponentPlan(candidateRoot, finalSequence, imageInputs, designCapsule);
        await assertLaunchMotionSidecar(candidateRoot, finalSequence);
        await writeDesignCapsuleReceipt(runRoot, candidateRoot, designCapsule);
      }

      let proofComparison: RunReceiptV1["proofComparison"] = null;
      if (request.kind === "revision") {
        const finalSequence = await readSequenceArtifact(candidateRoot);
        assertSemanticRevisionContained(baseSequence!, finalSequence!, request.revision!);
        proofComparison = await this.proofs.compare({
          jobId,
          baseRoot: this.projects.acceptedRoot(PROJECT_ID),
          candidateRoot,
          runRoot,
          scope: request.revision!,
        });
        if (!proofComparison.ok) {
          throw new Error("Revision changed pixels inside a declared unchanged proof region");
        }
        receipt = await this.runs.update(jobId, (current) => ({
          ...current,
          proofComparison,
          updatedAt: new Date().toISOString(),
        }));
      }

      const candidateCommit = await this.projects.createCandidateCommit(candidateRoot, jobId);
      const patch = await this.projects.candidatePatch(candidateRoot, baseCommit, candidateCommit);
      const inversePatch = await this.projects.candidatePatch(
        candidateRoot,
        candidateCommit,
        baseCommit,
      );
      await writeFile(join(runRoot, "changes.patch"), patch, { encoding: "utf8", mode: 0o600 });
      await writeFile(join(runRoot, "changes.inverse.patch"), inversePatch, {
        encoding: "utf8",
        mode: 0o600,
      });
      const applying = await this.runs.transition(jobId, "applying", {
        candidateCommit,
        patchSha256: sha256(patch),
        inversePatchSha256: sha256(inversePatch),
        proofComparison,
      });
      await this.event(
        applying,
        "verifying",
        "Video passed host checks; publishing it to the timeline",
      );
      try {
        const acceptedCommit = await this.projects.applyCandidate(baseCommit, candidateCommit);
        const applied = await this.runs.transition(jobId, "applied", {
          acceptedCommit,
          decision: null,
        });
        await this.event(applied, "complete", "Generated video is ready on the timeline");
      } catch (error) {
        if (error instanceof ApiProblem && error.code === "stale_base") {
          const stale = await this.runs.transition(jobId, "stale", {
            error: { code: "stale_base", message: error.message, owner: "git" },
          });
          await this.event(
            stale,
            "error",
            "The project changed while this video was being generated. Generate again from the current timeline.",
          );
          return;
        }
        throw error;
      }
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
            await this.skills.verifyInstalled(
              this.projects.candidateRoot(jobId),
              current.skillManifestDigest,
            );
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
          await this.event(
            updated,
            "error",
            "Protected Hyperframes skills could not be verified after the job",
          );
        }
      }
    }
  }

  /**
   * Deterministic, category-owned remediation: measured contrast repair and
   * lint-endorsed tween-overlap resolution. Each pass is transactional — a
   * mutation is adopted only when its own category strictly improves and no
   * other category regresses under a full re-verify; otherwise the candidate
   * is restored exactly. Called before creative layout repairs and again
   * after them, because an adopted repair can expose new deterministic debt.
   */
  private async runBalancedPrecompositionStages(options: {
    receipt: RunReceiptV1;
    jobId: string;
    candidateRoot: string;
    runRoot: string;
    baseCommit: string;
    prompt: string;
    imagePaths: readonly string[];
    skillProfile: CodexRunRequest["skillProfile"];
    authorContext: CodexRunRequest["authorContext"];
  }): Promise<{
    creativeLocks: ArtifactDigest[];
    componentLocks: ArtifactDigest[];
    componentSpecialist: boolean;
  }> {
    const creativeRoute = resolveAgentRoute(this.config, "creative_director");
    await this.event(
      options.receipt,
      "preparing",
      `${creativeRoute.model}/${creativeRoute.reasoningEffort} is locking design, story, and the component system`,
      { tool: "creative-direction" },
    );
    const creativeCheckpoint = await captureCandidateCheckpoint(options.candidateRoot);
    let creativeResult = await this.runCodexTurn({
      jobId: options.jobId,
      kind: "build",
      prompt: options.prompt,
      baseCommit: options.baseCommit,
      candidateRoot: options.candidateRoot,
      runRoot: options.runRoot,
      allowedPaths: PREPRODUCTION_STAGE_PATHS,
      imagePaths: options.imagePaths,
      skillProfile: options.skillProfile,
      authorContext: options.authorContext,
      threadId: null,
      operation: "creative_direction",
      agentRole: "creative_director",
      model: creativeRoute.model,
      reasoningEffort: creativeRoute.reasoningEffort,
      artifactDirectory: "turns/workflow-creative-direction",
      onProgress: (progress) => this.codexProgress(options.jobId, progress),
    });
    if (creativeResult.cancelled) {
      throw new Error(codexFailureMessage(creativeResult));
    }
    let creativeChanges = await this.restoreOutOfScopeTurnChanges({
      jobId: options.jobId,
      stage: "preparing",
      actor: "creative director",
      checkpoint: creativeCheckpoint,
      allowedPaths: PREPRODUCTION_STAGE_PATHS,
    });
    assertChangedPaths(creativeChanges, PREPRODUCTION_STAGE_PATHS);
    if (
      creativeChanges.length === 0 &&
      (creativeResult.timedOut || creativeResult.exitCode !== 0 || !creativeResult.final)
    ) {
      throw new Error(codexFailureMessage(creativeResult));
    }
    let missingPaths = missingPreproductionPaths(creativeChanges);
    if (missingPaths.length > 0) {
      await this.event(
        await this.runs.get(options.jobId),
        "preparing",
        `Preproduction did not replace ${missingPaths.join(", ")}; resuming the exact creative thread once`,
        { tool: "creative-direction-recovery" },
      );
      const recoveryCheckpoint = await captureCandidateCheckpoint(options.candidateRoot);
      const recoveryResult = await this.runCodexTurn({
        jobId: options.jobId,
        kind: "build",
        prompt: preproductionRecoveryPrompt(options.prompt, missingPaths),
        baseCommit: options.baseCommit,
        candidateRoot: options.candidateRoot,
        runRoot: options.runRoot,
        allowedPaths: PREPRODUCTION_STAGE_PATHS,
        imagePaths: options.imagePaths,
        skillProfile: options.skillProfile,
        authorContext: options.authorContext,
        threadId: creativeResult.threadId,
        operation: "creative_direction",
        agentRole: "creative_director",
        model: creativeRoute.model,
        reasoningEffort: creativeRoute.reasoningEffort,
        artifactDirectory: "turns/workflow-creative-direction-retry-1",
        onProgress: (progress) => this.codexProgress(options.jobId, progress),
      });
      if (
        recoveryResult.cancelled ||
        (!recoveryResult.diskComplete &&
          (recoveryResult.timedOut || recoveryResult.exitCode !== 0 || !recoveryResult.final))
      ) {
        throw new Error(codexFailureMessage(recoveryResult));
      }
      if (!recoveryResult.resumed || recoveryResult.threadId !== creativeResult.threadId) {
        throw new Error("Preproduction recovery did not resume the exact creative thread");
      }
      const recoveryChanges = await this.restoreOutOfScopeTurnChanges({
        jobId: options.jobId,
        stage: "preparing",
        actor: "creative director recovery",
        checkpoint: recoveryCheckpoint,
        allowedPaths: PREPRODUCTION_STAGE_PATHS,
      });
      assertChangedPaths(recoveryChanges, PREPRODUCTION_STAGE_PATHS);
      creativeResult = recoveryResult;
      creativeChanges = await creativeCheckpoint.changedPaths();
      missingPaths = missingPreproductionPaths(creativeChanges);
    }
    if (missingPaths.length > 0) {
      throw new Error(
        `Creative director did not replace required preproduction artifacts: ${missingPaths.join(", ")}`,
      );
    }
    await inspectChangedFiles(options.candidateRoot, creativeChanges);
    const normalizedMusicAnchors = await normalizeNumericMusicAnchors(options.candidateRoot);
    const normalizedCameraOwners = await normalizeDomCameraOwners(options.candidateRoot);
    const normalizedMotionVerbs = await normalizeDesignCapsuleMotionVerbs(options.candidateRoot);
    if (normalizedMusicAnchors > 0) {
      await this.event(
        await this.runs.get(options.jobId),
        "preparing",
        `Normalized ${normalizedMusicAnchors} numeric music anchor${normalizedMusicAnchors === 1 ? "" : "s"} into the string contract`,
        { tool: "workflow-contract-normalizer" },
      );
    }
    if (normalizedCameraOwners > 0) {
      await this.event(
        await this.runs.get(options.jobId),
        "preparing",
        `Normalized ${normalizedCameraOwners} semantic camera owner${normalizedCameraOwners === 1 ? "" : "s"} to the dom-world runtime class`,
        { tool: "workflow-contract-normalizer" },
      );
    }
    if (normalizedMotionVerbs > 0) {
      await this.event(
        await this.runs.get(options.jobId),
        "preparing",
        `Trimmed ${normalizedMotionVerbs} excess design motion verb${normalizedMotionVerbs === 1 ? "" : "s"} to the four-verb contract`,
        { tool: "workflow-contract-normalizer" },
      );
    }
    const validatePreproductionContract = async (): Promise<SequenceArtifactV1> => {
      const sequence = await readSequenceArtifact(options.candidateRoot);
      if (!sequence) throw new Error("Creative director did not author sequence.json");
      assertLaunchSequenceSemantics(sequence);
      await assertDesignCapsuleDirection(
        options.candidateRoot,
        options.imagePaths.map((path) => ({ path })),
      );
      ComponentPlanV2Schema.parse(
        JSON.parse(
          await readFile(join(options.candidateRoot, "story", "component-plan.json"), "utf8"),
        ) as unknown,
      );
      return sequence;
    };

    try {
      await validatePreproductionContract();
    } catch (error) {
      const failure = errorMessage(error);
      await this.event(
        await this.runs.get(options.jobId),
        "preparing",
        "Preproduction contract validation found a creative-owned mismatch; resuming the exact creative thread once before lock",
        { tool: "creative-direction-contract-repair" },
      );
      const repairCheckpoint = await captureCandidateCheckpoint(options.candidateRoot);
      const repairResult = await this.runCodexTurn({
        jobId: options.jobId,
        kind: "build",
        prompt: preproductionContractRepairPrompt(options.prompt, failure),
        baseCommit: options.baseCommit,
        candidateRoot: options.candidateRoot,
        runRoot: options.runRoot,
        allowedPaths: PREPRODUCTION_STAGE_PATHS,
        imagePaths: options.imagePaths,
        skillProfile: options.skillProfile,
        authorContext: options.authorContext,
        threadId: creativeResult.threadId,
        operation: "creative_direction",
        agentRole: "creative_director",
        model: creativeRoute.model,
        reasoningEffort: creativeRoute.reasoningEffort,
        artifactDirectory: "turns/workflow-creative-direction-contract-repair-1",
        onProgress: (progress) => this.codexProgress(options.jobId, progress),
      });
      if (
        repairResult.cancelled ||
        (!repairResult.diskComplete &&
          (repairResult.timedOut || repairResult.exitCode !== 0 || !repairResult.final))
      ) {
        throw new Error(codexFailureMessage(repairResult));
      }
      if (!repairResult.resumed || repairResult.threadId !== creativeResult.threadId) {
        throw new Error("Preproduction contract repair did not resume the exact creative thread");
      }
      const repairChanges = await this.restoreOutOfScopeTurnChanges({
        jobId: options.jobId,
        stage: "preparing",
        actor: "creative director contract repair",
        checkpoint: repairCheckpoint,
        allowedPaths: PREPRODUCTION_STAGE_PATHS,
      });
      if (repairChanges.length === 0) {
        throw new Error("Preproduction contract repair ended without changing any project files");
      }
      assertChangedPaths(repairChanges, PREPRODUCTION_STAGE_PATHS);
      await inspectChangedFiles(options.candidateRoot, repairChanges);
      await normalizeNumericMusicAnchors(options.candidateRoot);
      await normalizeDomCameraOwners(options.candidateRoot);
      await normalizeDesignCapsuleMotionVerbs(options.candidateRoot);
      await validatePreproductionContract();
      creativeResult = repairResult;
      creativeChanges = await creativeCheckpoint.changedPaths();
      assertChangedPaths(creativeChanges, PREPRODUCTION_STAGE_PATHS);
      await inspectChangedFiles(options.candidateRoot, creativeChanges);
    }
    if (creativeResult.diskComplete && !creativeResult.final) {
      await this.event(
        await this.runs.get(options.jobId),
        "preparing",
        "Preproduction handoff accepted from validated disk artifacts",
        { tool: "workflow-disk-truth" },
      );
    }
    const creativeLocks = await captureArtifactDigests(options.candidateRoot, CREATIVE_STAGE_PATHS);
    const componentLocks = await captureArtifactDigests(options.candidateRoot, componentStagePaths);
    await mkdir(join(options.runRoot, "workflow"), { recursive: true });
    await writeFile(
      join(options.runRoot, "workflow", "creative-lock.json"),
      `${JSON.stringify(
        {
          version: "sequences.workflow-lock.v1",
          role: "creative_director",
          threadId: creativeResult.threadId,
          artifacts: creativeLocks,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    await writeFile(
      join(options.runRoot, "workflow", "component-lock.json"),
      `${JSON.stringify(
        {
          version: "sequences.workflow-lock.v1",
          role: "creative_director",
          threadId: creativeResult.threadId,
          artifacts: componentLocks,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return { creativeLocks, componentLocks, componentSpecialist: true };
  }

  private async restoreOutOfScopeTurnChanges(options: {
    jobId: string;
    stage: "preparing" | "authoring" | "verifying";
    actor: string;
    checkpoint: CandidateCheckpoint;
    allowedPaths: readonly string[];
  }): Promise<string[]> {
    let changedPaths = await options.checkpoint.changedPaths();
    const restoredPaths = changedPaths.filter(
      (file) => !options.allowedPaths.some((pattern) => pathMatches(pattern, file)),
    );
    if (restoredPaths.length === 0) return changedPaths;

    await options.checkpoint.restorePaths(restoredPaths);
    changedPaths = await options.checkpoint.changedPaths();
    const pathSummary = restoredPaths.slice(0, 4).join(", ");
    const remainingCount = Math.max(0, restoredPaths.length - 4);
    await this.event(
      await this.runs.get(options.jobId),
      options.stage,
      `Host restored ${restoredPaths.length} out-of-scope ${options.actor} edit${restoredPaths.length === 1 ? "" : "s"} before validation: ${pathSummary}${remainingCount > 0 ? `, and ${remainingCount} more` : ""}`,
      { tool: "workflow-custody" },
    );
    return changedPaths;
  }

  private async runCodexTurn(request: CodexRunRequest): Promise<CodexRunResult> {
    const role = request.agentRole ?? "legacy_director";
    const route = resolveAgentRoute(this.config, role);
    let activeRequest = request;
    for (let retry = 0; ; retry += 1) {
      const result = await this.codex.run(activeRequest);
      await this.runs.update(request.jobId, (current) => ({
        ...current,
        agentWorkflow: {
          ...current.agentWorkflow,
          turns: [
            ...current.agentWorkflow.turns,
            {
              version: "sequences.codex-turn.v1",
              operation: activeRequest.operation ?? "author",
              role,
              model: result.model ?? activeRequest.model ?? route.model,
              reasoningEffort:
                result.reasoningEffort ?? activeRequest.reasoningEffort ?? route.reasoningEffort,
              threadId: result.threadId,
              resumed: result.resumed,
              artifactDirectory: activeRequest.artifactDirectory ?? null,
              cliVersion: result.cliVersion,
              sanitizedArguments: result.sanitizedArguments,
              durationMs: result.durationMs ?? 0,
              usage: result.usage ?? null,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              cancelled: result.cancelled,
            },
          ],
        },
        updatedAt: new Date().toISOString(),
      }));
      if (retry >= 2 || !isTransientCodexFailure(result)) return result;

      const nextRetry = retry + 1;
      await this.event(
        await this.runs.get(request.jobId),
        "authoring",
        `The ${role.replaceAll("_", " ")} route is temporarily unavailable; retrying the exact thread (${nextRetry}/2)`,
        { tool: "codex-retry" },
      );
      await new Promise((resolve) => setTimeout(resolve, nextRetry * 1_000));
      activeRequest = {
        ...request,
        threadId: result.threadId,
        artifactDirectory: `${request.artifactDirectory ?? "turns/codex"}-retry-${nextRetry}`,
      };
    }
  }

  private async remediateQaCategories(context: {
    jobId: string;
    candidateRoot: string;
    runRoot: string;
    sequence: SequenceArtifactV1;
    allowedPaths: readonly string[];
    receipt: RunReceiptV1;
    qaRemediations: NonNullable<RunReceiptV1["qaRemediations"]>;
    qa: QaReceiptV1;
    qaAttempt: number;
    qaArtifact: string;
    maxQaAttempt: number;
  }): Promise<{ qa: QaReceiptV1; qaAttempt: number; qaArtifact: string }> {
    const { jobId, candidateRoot, runRoot, sequence, allowedPaths, receipt, qaRemediations } =
      context;
    let { qa, qaAttempt, qaArtifact } = context;

    while (!qa.ok && qaAttempt < context.maxQaAttempt && actionableContrastCount(qa) > 0) {
      const inputQaArtifact = qaArtifact;
      const beforeContrast = actionableContrastCount(qa);
      const beforeContrastDeficit = actionableContrastDeficit(qa);
      const beforeOther = actionableNonContrastCount(qa);
      const priorRepairs = qaRemediations
        .filter((entry) => entry.category === "contrast")
        .flatMap((entry) => entry.repaired);
      const mutation = await this.contrastFixer.apply(
        candidateRoot,
        qa,
        allowedPaths,
        priorRepairs,
      );
      if (mutation.repaired.length === 0) break;
      const outputQaAttempt = qaAttempt + 1;
      const outputQaArtifact = `qa/attempt-${outputQaAttempt}/qa.json`;
      let candidateQa: QaReceiptV1;
      try {
        candidateQa = await this.hyperframes.verify(jobId, candidateRoot, runRoot, {
          artifactDirectory: `qa/attempt-${outputQaAttempt}`,
          sequence,
        });
      } catch (error) {
        await mutation.restore();
        throw error;
      }
      qaAttempt = outputQaAttempt;
      const afterContrast = actionableContrastCount(candidateQa);
      const improved =
        actionableNonContrastCount(candidateQa) <= beforeOther &&
        (afterContrast < beforeContrast ||
          (afterContrast === beforeContrast &&
            actionableContrastDeficit(candidateQa) < beforeContrastDeficit - 0.001));
      if (!improved) {
        await mutation.restore();
        await writeFile(join(runRoot, "qa.json"), `${JSON.stringify(qa, null, 2)}\n`, "utf8");
        break;
      }
      qaRemediations.push(
        QaRemediationV1Schema.parse({
          version: "sequences.qa-remediation.v1",
          category: "contrast",
          fixerVersion: "sequences.contrast-fixer.v1",
          pass: qaRemediations.filter((entry) => entry.category === "contrast").length + 1,
          inputArtifact: inputQaArtifact,
          outputArtifact: outputQaArtifact,
          repaired: mutation.repaired,
        }),
      );
      qa = candidateQa;
      qaArtifact = outputQaArtifact;
      await this.event(
        receipt,
        "verifying",
        `Contrast category remediated ${mutation.repaired.length} selector${mutation.repaired.length === 1 ? "" : "s"}; QA is rechecking the candidate`,
        { tool: "contrast-fixer" },
      );
    }

    const tweenPasses = qaRemediations.filter((entry) => entry.category === "tween_overlap").length;
    if (
      !qa.ok &&
      qaAttempt < context.maxQaAttempt &&
      tweenPasses < 2 &&
      actionableTweenOverlapCount(qa) > 0
    ) {
      const inputQaArtifact = qaArtifact;
      const beforeOverlap = actionableTweenOverlapCount(qa);
      const beforeOther = actionableFindingCount(qa) - beforeOverlap;
      const mutation = await this.tweenOverlapFixer.apply(candidateRoot, qa, allowedPaths);
      if (mutation.repaired.length > 0) {
        const outputQaAttempt = qaAttempt + 1;
        const outputQaArtifact = `qa/attempt-${outputQaAttempt}/qa.json`;
        let candidateQa: QaReceiptV1;
        try {
          candidateQa = await this.hyperframes.verify(jobId, candidateRoot, runRoot, {
            artifactDirectory: `qa/attempt-${outputQaAttempt}`,
            sequence,
          });
        } catch (error) {
          await mutation.restore();
          throw error;
        }
        qaAttempt = outputQaAttempt;
        const afterOverlap = actionableTweenOverlapCount(candidateQa);
        const improved =
          afterOverlap < beforeOverlap &&
          actionableFindingCount(candidateQa) - afterOverlap <= beforeOther;
        if (!improved) {
          await mutation.restore();
          await writeFile(join(runRoot, "qa.json"), `${JSON.stringify(qa, null, 2)}\n`, "utf8");
        } else {
          qaRemediations.push(
            QaRemediationV1Schema.parse({
              version: "sequences.qa-remediation.v1",
              category: "tween_overlap",
              fixerVersion: "sequences.tween-overlap-fixer.v1",
              pass: tweenPasses + 1,
              inputArtifact: inputQaArtifact,
              outputArtifact: outputQaArtifact,
              repaired: mutation.repaired,
            }),
          );
          qa = candidateQa;
          qaArtifact = outputQaArtifact;
          await this.event(
            receipt,
            "verifying",
            `Tween-overlap category remediated ${mutation.repaired.length} conflict${mutation.repaired.length === 1 ? "" : "s"}; QA is rechecking the candidate`,
            { tool: "tween-overlap-fixer" },
          );
        }
      }
    }

    return { qa, qaAttempt, qaArtifact };
  }

  private async stopIfCancelled(jobId: string): Promise<void> {
    if ((await this.runs.get(jobId)).state === "cancelled")
      throw new Error("Job was cancelled during preparation");
  }

  private async codexProgress(jobId: string, progress: CodexProgress): Promise<void> {
    const receipt = await this.runs.get(jobId);
    if (
      receipt.state !== "preparing" &&
      receipt.state !== "authoring" &&
      receipt.state !== "verifying"
    )
      return;
    await this.event(receipt, receipt.state, progress.message, {
      ...(progress.tool ? { tool: progress.tool } : {}),
      ...(progress.currentFile ? { currentFile: progress.currentFile } : {}),
    });
  }

  private async event(
    receipt: RunReceiptV1,
    stage:
      | "queued"
      | "preparing"
      | "authoring"
      | "verifying"
      | "review"
      | "decision"
      | "complete"
      | "error",
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
}

function verifyReportedSkills(
  reported: readonly string[],
  installed: readonly string[],
  requiredSkills: readonly string[],
): string[] {
  const installedSet = new Set(installed);
  const normalized = [...new Set(reported.map(skillName))].sort();
  for (const skill of normalized) {
    if (!installedSet.has(skill))
      throw new Error(`Codex reported an unknown Hyperframes skill: ${skill}`);
  }
  for (const required of requiredSkills) {
    if (!normalized.includes(required))
      throw new Error(`Codex did not report reading required skill: ${required}`);
  }
  return normalized;
}

function enforceFreshBuildMode(request: StartJobRequestV1): void {
  if (request.kind === "build" && request.directorMode === "reset" && !request.revision) return;
  throw new ApiProblem(
    422,
    "unsupported_job_mode",
    "Phase 1 accepts only fresh build jobs; prior-run continuation and revision are unavailable",
  );
}

function skillName(value: string): string {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  const skillsIndex = parts.lastIndexOf("skills");
  return skillsIndex >= 0 && parts[skillsIndex + 1] ? parts[skillsIndex + 1]! : (parts[0] ?? value);
}

async function writeDesignCapsuleReceipt(
  runRoot: string,
  candidateRoot: string,
  capsule: DesignCapsuleV1,
): Promise<void> {
  const raw = await readFile(await existingFileWithin(candidateRoot, DESIGN_CAPSULE_PATH));
  await writeFile(
    join(runRoot, "design-capsule-receipt.json"),
    `${JSON.stringify(
      {
        version: "sequences.design-capsule-receipt.v1",
        path: DESIGN_CAPSULE_PATH,
        id: capsule.id,
        origin: capsule.origin,
        sha256: sha256(raw),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export async function validateFreshBuildContract(options: {
  candidateRoot: string;
  authoredChangedFiles: readonly string[];
  imageInputs: readonly ImageInputV1[];
  audioDirector?: AudioDirector;
  onMotionSelectorMissing?: (finding: MotionSelectorMissingNormalization) => void;
}): Promise<SequenceArtifactV1> {
  const failures: string[] = [];
  const capture = async (check: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await check();
    } catch (error) {
      failures.push(errorMessage(error));
    }
  };

  if (!options.authoredChangedFiles.includes("index.motion.json")) {
    failures.push(
      "A Phase 1 SaaS launch build must author index.motion.json so motion is verified",
    );
  }

  let sequence: SequenceArtifactV1 | null = null;
  try {
    sequence = await readSequenceArtifact(options.candidateRoot);
  } catch (error) {
    failures.push(errorMessage(error));
  }
  if (sequence) {
    await capture(() => {
      if (sequence!.revision !== null) {
        throw new Error("A new build must leave sequence.json revision scope empty");
      }
    });
    await capture(() => assertLaunchSequenceSemantics(sequence!));
    if (options.audioDirector) {
      // The authored sound plan is part of the same semantic contract; an
      // invalid declaration joins the aggregated packet so the bounded
      // same-thread contract repair can fix it instead of failing the run.
      await capture(() => options.audioDirector!.assertAudioDirection(sequence!));
    }
    await capture(() =>
      assertFreshBuildAuthored(options.candidateRoot, sequence!, options.authoredChangedFiles),
    );
    await capture(() => assertLaunchMotionSidecar(options.candidateRoot, sequence!));
  }

  let designCapsule: DesignCapsuleV1 | null = null;
  try {
    designCapsule = await assertDesignCapsule(options.candidateRoot, options.imageInputs);
  } catch (error) {
    failures.push(errorMessage(error));
    // Full design validation includes implementation bindings. Preserve the
    // parsed machine contract when those bindings fail so component validation
    // can still report its independent errors in this same repair packet.
    try {
      designCapsule = await readDesignCapsule(options.candidateRoot);
    } catch {
      // The full design error already contains the authoritative parse failure.
    }
  }
  if (sequence && designCapsule) {
    await capture(() =>
      assertComponentPlan(options.candidateRoot, sequence!, options.imageInputs, designCapsule!),
    );
  }

  const uniqueFailures = [...new Set(failures)];
  if (uniqueFailures.length > 0) {
    throw new Error(
      `Fresh-build contract validation found ${uniqueFailures.length} mismatch${uniqueFailures.length === 1 ? "" : "es"}:\n${uniqueFailures.map((failure, index) => `${index + 1}. ${failure}`).join("\n")}`,
    );
  }
  // All semantic and machine contracts are valid before this narrow host
  // normalization is allowed to mutate selector targets.
  await normalizeLaunchMotionSidecarTargets(options.candidateRoot, sequence!, {
    ...(options.onMotionSelectorMissing
      ? { onMotionSelectorMissing: options.onMotionSelectorMissing }
      : {}),
  });
  return sequence!;
}

export function reconcileCodexFinalArtifacts(
  final: CodexFinalV1,
  hostChangedFiles: readonly string[],
): CodexFinalV1 {
  return {
    ...final,
    artifacts: [...new Set(hostChangedFiles)].sort(),
  };
}

function withMotionSelectorMissingNormalizations(
  qa: QaReceiptV1,
  normalizations: readonly MotionSelectorMissingNormalization[],
): QaReceiptV1 {
  if (normalizations.length === 0) return qa;
  const existing = new Set(
    qa.findings
      .filter((finding) => finding.code === "motion_selector_missing")
      .map((finding) => finding.selector),
  );
  const findings = normalizations.flatMap((normalization) => {
    const selector = normalization.selectors[0] ?? null;
    if (existing.has(selector)) return [];
    existing.add(selector);
    return [
      {
        command: "check" as const,
        category: "motion",
        code: "motion_selector_missing",
        severity: "info" as const,
        sourceFile: "index.motion.json",
        selector,
        times: [],
        message: `Host dropped the authored ${normalization.assertionKind} assertion because ${normalization.selectors.join(", ")} matched neither a DOM id nor data-hf-id after reconciliation.`,
        fixHint: null,
        artifact: "index.motion.json",
      },
    ];
  });
  if (findings.length === 0) return qa;
  return {
    ...qa,
    summary: {
      ...qa.summary,
      infoCount: qa.summary.infoCount + findings.length,
    },
    findings: [...qa.findings, ...findings],
  };
}

async function recoverAuthorFinalFromDisk(options: {
  candidateRoot: string;
  kind: StartJobRequestV1["kind"];
  originalPrompt: string;
  changedDuringAuthoring: readonly string[];
  allowedPaths: readonly string[];
  requiredSkills: readonly string[];
}): Promise<CodexFinalV1 | null> {
  if (options.kind !== "build" || options.changedDuringAuthoring.length === 0) return null;
  for (const requiredFile of RECOVERABLE_FRESH_BUILD_FILES) {
    try {
      await existingFileWithin(options.candidateRoot, requiredFile);
    } catch (error) {
      if (error instanceof ApiProblem && error.code === "file_not_found") return null;
      throw error;
    }
  }

  // Recovery is only a transport fallback for a model process that ended
  // after writing. Inspect the complete authoring diff rather than only the
  // second turn's delta: the first turn may have materialized a complete
  // candidate immediately before its transport stalled, leaving the exact
  // thread with nothing further to change. This does not weaken custody; the
  // complete diff is scope/content inspected here, then the normal semantic
  // contract and strict HyperFrames QA still decide whether it can promote.
  assertChangedPaths(options.changedDuringAuthoring, options.allowedPaths);
  await inspectChangedFiles(options.candidateRoot, options.changedDuringAuthoring);
  return {
    version: "sequences.codex-final.v1",
    intent:
      `Finish the requested fresh video from disk after author recovery: ${options.originalPrompt}`.slice(
        0,
        2_000,
      ),
    artifacts: [...new Set(options.changedDuringAuthoring)].sort(),
    skillsUsed: [...new Set(options.requiredSkills)].sort(),
    limitations: [
      "The same-thread author recovery ended without a usable schema response; the host recovered only materialized disk changes and still requires the full contract and strict QA gates.",
    ],
    proofTimes: [],
  };
}

function classifyFailure(error: unknown): RunReceiptV1["error"] {
  const message = errorMessage(error).slice(0, 4_000);
  if (/sandbox resolved to read-only|writing is blocked by read-only sandbox/i.test(message)) {
    return { code: "codex_sandbox_read_only", message, owner: "codex" };
  }
  if (
    /fresh-build policy|component-plan\.json|design-capsule\.json|frame\.md|index\.motion\.json/i.test(
      message,
    )
  )
    return { code: "fresh_build_contract_failed", message, owner: "policy" };
  if (/hyperframes|lint|strict check/i.test(message))
    return { code: "hyperframes_verification_failed", message, owner: "hyperframes" };
  if (/sequence\.json|semantic artifact/i.test(message))
    return { code: "semantic_contract_failed", message, owner: "policy" };
  if (/revision|proof|semantic/i.test(message))
    return { code: "revision_scope_failed", message, owner: "policy" };
  if (/codex|gpt-5\.6/i.test(message))
    return { code: "codex_authoring_failed", message, owner: "codex" };
  if (/skill|scope|protected|external asset|artifact inventory/i.test(message))
    return { code: "candidate_policy_failed", message, owner: "policy" };
  if (/git|worktree|commit/i.test(message))
    return { code: "git_candidate_failed", message, owner: "git" };
  return { code: "job_failed", message, owner: "server" };
}

function userFacingFailure(error: unknown): string {
  const message = errorMessage(error);
  if (/sandbox resolved to read-only|writing is blocked by read-only sandbox/i.test(message)) {
    return "The local Codex sandbox is read-only; authoring was stopped before QA";
  }
  if (
    /fresh-build policy|component-plan\.json|design-capsule\.json|frame\.md|index\.motion\.json/i.test(
      message,
    )
  )
    return "Generated video did not replace the starter with a complete product-specific build";
  if (/lint|strict check|Hyperframes/i.test(message))
    return "Generated video did not pass the pinned Hyperframes verification gate";
  if (/scope|protected|external asset/i.test(message))
    return "Generated video changed content outside its approved safety scope";
  if (/sequence\.json|semantic artifact/i.test(message))
    return "Generated video did not produce the required semantic result contract";
  if (/revision|proof|semantic/i.test(message))
    return "Generated video did not preserve the declared semantic scope";
  if (/Codex/i.test(message)) return "Agent authoring ended without a valid generated video";
  return "Generation failed; the previous timeline video is unchanged";
}

function actionableContrastCount(qa: QaReceiptV1): number {
  return qa.findings.filter(
    (finding) => finding.category === "contrast" && finding.severity !== "info",
  ).length;
}

function actionableContrastDeficit(qa: QaReceiptV1): number {
  return qa.findings.reduce((total, finding) => {
    if (finding.category !== "contrast" || finding.severity === "info" || !finding.contrast) {
      return total;
    }
    const deficit = finding.contrast.samples.reduce(
      (largest, sample) => Math.max(largest, sample.requiredRatio - sample.ratio),
      0,
    );
    return total + deficit;
  }, 0);
}

function actionableNonContrastCount(qa: QaReceiptV1): number {
  return qa.findings.filter(
    (finding) => finding.category !== "contrast" && finding.severity !== "info",
  ).length;
}

function actionableFindingCount(qa: QaReceiptV1): number {
  return qa.findings.filter((finding) => finding.severity !== "info").length;
}

function isAuthorOwnedMotionFinding(finding: QaReceiptV1["findings"][number]): boolean {
  return (
    finding.severity !== "info" &&
    (finding.code === "motion_appears_late" || finding.code === "motion_frozen")
  );
}

function authorOwnedMotionFindingCount(qa: QaReceiptV1): number {
  return qa.findings.filter(isAuthorOwnedMotionFinding).length;
}

function actionableUnownedNonDeterministicNonLayoutCount(qa: QaReceiptV1): number {
  return qa.findings.filter(
    (finding) =>
      finding.severity !== "info" &&
      finding.category !== "layout_inspection" &&
      !isRepairableLayoutFinding(finding) &&
      finding.category !== "contrast" &&
      finding.code !== "overlapping_gsap_tweens" &&
      !isAuthorOwnedMotionFinding(finding),
  ).length;
}

function mergeQaRepairFindings(
  carried: QaReceiptV1["findings"],
  current: QaReceiptV1["findings"],
): QaReceiptV1["findings"] {
  const merged: QaReceiptV1["findings"] = [];
  const seen = new Set<string>();
  for (const finding of [...carried, ...current]) {
    const key = JSON.stringify([
      finding.code,
      finding.sourceFile,
      finding.selector,
      finding.times,
      finding.message,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(finding);
  }
  return merged;
}

function actionableTweenOverlapCount(qa: QaReceiptV1): number {
  return qa.findings.filter(
    (finding) => finding.code === "overlapping_gsap_tweens" && finding.severity !== "info",
  ).length;
}

function unresolvedLayoutClusters(qa: QaReceiptV1): LayoutClusterV1[] {
  return (qa.layoutClusters ?? []).filter((cluster) => cluster.status !== "declared_legible");
}

function unresolvedLayoutFindingCount(qa: QaReceiptV1): number {
  return unresolvedLayoutClusters(qa).reduce((count, cluster) => count + cluster.findingCount, 0);
}

export function actionableNonLayoutCount(qa: QaReceiptV1): number {
  return qa.findings.filter(
    (finding) =>
      finding.severity !== "info" &&
      // Inspection failures remain strict-QA blockers, but they are evidence
      // failures for a layout cluster—not a new candidate regression. Do not
      // discard a bounded repair that materially reduces the underlying
      // HyperFrames layout findings merely because a remaining cluster cannot
      // yield an inspectable entity pair.
      finding.category !== "layout_inspection" &&
      !isRepairableLayoutFinding(finding),
  ).length;
}

/**
 * Layout repair is immediately followed by transactional category-owned
 * cleanup. Do not discard a material layout improvement merely because it
 * exposes contrast or a lint-endorsed tween collision that those deterministic
 * fixers own. Runtime, motion, and every other non-layout regression remain a
 * hard adoption veto.
 */
export function actionableNonDeterministicNonLayoutCount(qa: QaReceiptV1): number {
  return qa.findings.filter(
    (finding) =>
      finding.severity !== "info" &&
      finding.category !== "layout_inspection" &&
      !isRepairableLayoutFinding(finding) &&
      finding.category !== "contrast" &&
      finding.code !== "overlapping_gsap_tweens",
  ).length;
}

export function hasLayoutRepairBudget(repairIndex: number, qaAttempt: number): boolean {
  return repairIndex >= 1 && repairIndex <= 3 && qaAttempt < LAYOUT_QA_ATTEMPT_CEILING;
}

export function qaRepairAllowedPaths(
  findings: QaReceiptV1["findings"],
  sequence: SequenceArtifactV1,
  originalAllowedPaths: readonly string[],
): string[] {
  const requested = new Set<string>(["index.motion.json", "sequence.json"]);
  for (const finding of findings) {
    if (finding.sourceFile) requested.add(finding.sourceFile);
  }
  // A runtime motion finding can identify a selector and sample time without
  // knowing which mounted composition owns it. In that case, let the resumed
  // director edit only the existing implementation files declared by the
  // semantic sequence, rather than reopening the whole fresh-build scope.
  const hasAssembledRuntimeWarning = findings.some(
    (finding) =>
      finding.category === "runtime" &&
      finding.code === "console_warning" &&
      finding.selector === "[data-composition-id]",
  );
  if (findings.some((finding) => finding.sourceFile === null) || hasAssembledRuntimeWarning) {
    requested.add("index.html");
    for (const beat of sequence.beats) {
      for (const implementationFile of beat.implementationFiles ?? []) {
        requested.add(implementationFile);
      }
    }
  }
  const scoped = [...requested].filter((file) =>
    originalAllowedPaths.some((pattern) => pathMatches(pattern, file)),
  );
  if (scoped.length === 0) {
    throw new Error("Residual HyperFrames QA has no repairable file inside the original job scope");
  }
  if (scoped.length > 24) {
    throw new Error("Residual HyperFrames QA exceeds the 24-file focused repair boundary");
  }
  return scoped.sort();
}

function layoutRepairAllowedPaths(
  cluster: LayoutClusterV1,
  findings: QaReceiptV1["findings"],
  originalAllowedPaths: readonly string[],
): string[] {
  const requested = [
    ...new Set([
      ...cluster.sourceFiles,
      "index.html",
      ...(findings.some(isAuthorOwnedMotionFinding) ? ["index.motion.json"] : []),
      "sequence.json",
    ]),
  ].filter((file) => originalAllowedPaths.some((pattern) => pathMatches(pattern, file)));
  if (requested.length === 0) {
    throw new Error("Layout cluster has no repairable file inside the original job scope");
  }
  if (requested.length > 16) {
    throw new Error("Layout cluster exceeds the 16-file focused repair boundary");
  }
  return requested.sort();
}

function findingsForLayoutClusters(
  qa: QaReceiptV1,
  clusters: readonly LayoutClusterV1[],
): QaReceiptV1["findings"] {
  const sourceFiles = new Set(clusters.flatMap((cluster) => cluster.sourceFiles));
  return qa.findings
    .filter(
      (finding) =>
        finding.severity !== "info" &&
        ((isRepairableLayoutFinding(finding) &&
          finding.sourceFile !== null &&
          sourceFiles.has(finding.sourceFile)) ||
          isAuthorOwnedMotionFinding(finding)),
    )
    .slice(0, 30);
}

export function layoutRepairClusterBatch(
  unresolved: readonly LayoutClusterV1[],
): LayoutClusterV1[] {
  const primary = unresolved[0];
  if (!primary) return [];
  const sourceFiles = new Set(primary.sourceFiles);
  return unresolved
    .filter((cluster) => cluster.sourceFiles.some((file) => sourceFiles.has(file)))
    .slice(0, 8);
}

function layoutRepairBatchSummary(clusters: readonly LayoutClusterV1[]): string {
  if (clusters.length === 1) return clusters[0]!.summary;
  return `${clusters.length} related layout clusters in ${[...new Set(clusters.flatMap((cluster) => cluster.sourceFiles))].join(", ")}`;
}

type LayoutRepairFeedback = {
  reason: string;
  findings: QaReceiptV1["findings"];
};

export function layoutRepairFeedback(
  reason: string,
  candidateQa: QaReceiptV1 | null,
): LayoutRepairFeedback {
  return {
    reason,
    findings:
      candidateQa?.findings.filter((finding) => finding.severity !== "info").slice(0, 12) ?? [],
  };
}

function layoutRepairPrompt(
  clusters: readonly LayoutClusterV1[],
  attempt: number,
  priorFeedback: LayoutRepairFeedback | null = null,
): string {
  const primary = clusters[0]!;
  const findingCount = clusters.reduce((count, cluster) => count + cluster.findingCount, 0);
  const retryEvidence = priorFeedback
    ? [
        `The previous repair was transactionally rolled back: ${priorFeedback.reason}.`,
        ...(priorFeedback.findings.length > 0
          ? [
              "Its full renderer recheck exposed these blockers. Avoid reproducing them while fixing the original cluster:",
              ...priorFeedback.findings.map((finding) => {
                const where = finding.selector ?? finding.sourceFile ?? "unknown target";
                const at =
                  finding.times.length > 0
                    ? ` at ${finding.times.map((time) => `${time.toFixed(3)}s`).join(", ")}`
                    : "";
                return `- [${finding.category}/${finding.code}] ${where}${at}: ${finding.message}`;
              }),
            ]
          : []),
      ]
    : [];
  return [
    `Focused layout repair attempt ${attempt} of 3.`,
    layoutRepairBatchSummary(clusters),
    `Primary cluster ${primary.id} at ${primary.sampleTime.toFixed(3)}s; the batch contains ${findingCount} reported descendants.`,
    ...retryEvidence,
    "The supplied findings share an implementation composition. Repair their common DOM, CSS, or motion-order cause as one class, including every supplied handoff/time, rather than treating only the primary screenshot. Use exact geometry, fix hints, the inspect_layout packet, and images. Repair this existing candidate in place; do not regenerate it.",
    "A text overflow finding must be fixed by bringing the implicated text box inside its real container through layout, size, or wrapping; do not hide it, suppress the detector, or misclassify it as intentional overlap.",
    "A container overflow must be fixed at its largest animated pose. Reposition or resize readable UI. A genuinely decorative bleed may use data-layout-allow-overflow on the narrow decorative element itself. A motivated product close-up may use it only on the smallest moving inner camera layer inside a fixed clipped viewport, never on the root, viewport, persistent readable panel, or focal target; the focal target and primary copy must remain fully inside the safe area at every landed pose.",
    "For sequential blocks in normal document flow, opacity or visibility alone does not remove the outgoing block's layout space. At the handoff, use an atomic GSAP set with display:none on the outgoing block and restore the incoming block's display before revealing it, or place the states in an intentional shared grid/absolute stack; verify the later block's actual top and bottom edges after the handoff.",
    "Keep readable content inside the supplied safe area and preserve camera headroom. Do not solve a camera overflow by clipping critical UI at a full-frame ancestor.",
    "Full readable UI state layers must not crossfade or coexist. At their handoff, use an atomic GSAP set of display/visibility/autoAlpha so outgoing readable descendants are hidden in the same instant the incoming state becomes visible; animate only the stable shell or genuinely shared entity around that cut.",
    "The packet may also include motion_appears_late or motion_frozen from this same authored composition. Repair motion_appears_late by making the intended subject measurably visible by its claimed time or correcting that authored sidecar claim. Repair motion_frozen by giving the intended subject meaningful deterministic transform motion or correcting its authored claim. The host will not rewrite authored timing for you.",
    "Choose only one semantically appropriate response: reposition/reflow the implicated entities, adjust their handoff timing, or declare a narrow legitimate overlap in sequence.json with exact entity IDs and rationale.",
    "List only files changed during this repair turn in the final artifact inventory.",
  ].join(" ");
}

function authorRecoveryPrompt(failure: string, owner = "Luna director"): string {
  return [
    `Authoring recovery on the exact same ${owner} thread.`,
    `The prior turn did not materialize a complete candidate: ${failure.slice(0, 1_000)}`,
    "The existing candidate filesystem is disk truth. Inspect what is present, then finish the original user brief in place.",
    "You must actually write every required artifact and implementation file; do not merely describe a patch or return an intent-only response.",
    "Before finishing, verify that root frame.md, story/design-capsule.json, story/component-plan.json, sequence.json, index.motion.json, index.html, and every claimed implementation file exist on disk.",
    "Preserve any valid work already authored and list the complete changed artifact inventory in the final response.",
  ].join(" ");
}

function preproductionRecoveryPrompt(
  originalPrompt: string,
  missingPaths: readonly string[],
): string {
  return [
    "Preproduction disk-completeness recovery on the exact same creative-director thread.",
    `The original video brief remains binding: ${JSON.stringify(originalPrompt)}`,
    `The host found that these required locked artifacts still match the starter and were not authored: ${missingPaths.join(", ")}.`,
    "Inspect the preproduction artifacts already on disk, preserve their valid product-specific decisions, and finish the complete four-file handoff in place: frame.md, sequence.json, story/design-capsule.json, and story/component-plan.json.",
    "Every component beat reference must exist in the authored sequence, and sequence.json must contain the requested multi-beat causal story rather than the generic fresh-build starter.",
    "Write the missing correction to disk and report every preproduction artifact changed during this recovery.",
  ].join(" ");
}

function preproductionContractRepairPrompt(originalPrompt: string, failure: string): string {
  return [
    "Preproduction contract repair on the exact same creative-director thread, before the design and story artifacts are locked.",
    `The original video brief remains binding: ${JSON.stringify(originalPrompt)}`,
    `The host rejected the proposed creative handoff for this exact objective reason: ${failure.slice(0, 2_000)}`,
    "Repair only that mismatch in frame.md, sequence.json, story/design-capsule.json, or story/component-plan.json as needed; do not broaden or redesign the approved direction.",
    "Keep all supplied reference images bound in their original host order and keep the four preproduction artifacts mutually consistent.",
    "Write the correction to disk and report every preproduction artifact changed during this repair.",
  ].join(" ");
}

function freshContractRepairPrompt(
  failure: string,
  attempt: number,
  maximum: number,
  owner = "Luna director",
): string {
  return [
    `Fresh-build contract repair ${attempt} of ${maximum} on the exact same ${owner} thread.`,
    `The host rejected the authored candidate for this exact reason: ${failure.slice(0, 2_000)}`,
    "Repair that contract class in the existing candidate; do not regenerate, redesign, or change unrelated choreography.",
    "Treat the host error as authoritative. Cross-check sequence.json, root frame.md, story/design-capsule.json, story/component-plan.json, index.motion.json, and the actual DOM together so IDs, beat ownership, files, tokens, states, and morph anchors agree verbatim.",
    "For a component-containment failure, move the one real declared part under its own declared root or create the intended root-owned visual proxy there; changing only GSAP selectors or data-state values does not repair DOM containment.",
    "You must write the correction to disk and return the complete changed artifact inventory.",
  ].join(" ");
}

function qaRepairPrompt(
  findings: QaReceiptV1["findings"],
  attempt: number,
  originalPrompt: string,
  imagePaths: readonly string[],
  evidenceImageCount = 0,
): string {
  const lines = findings.map((finding) => {
    const at =
      finding.times.length > 0
        ? ` at ${finding.times.map((time) => `${time.toFixed(3)}s`).join(", ")}`
        : "";
    const where = finding.selector ?? finding.sourceFile ?? "unknown target";
    const hint = finding.fixHint ? ` Fix hint: ${finding.fixHint}` : "";
    return `- [${finding.category}/${finding.code}] ${where}${at}: ${finding.message}${hint}`;
  });
  return [
    `Focused residual HyperFrames QA repair ${attempt} of 2 on the exact same director thread. Fix each supplied finding narrowly in the existing candidate. Do not regenerate, restyle, or retime anything unrelated.`,
    `The original user brief remains binding creative intent: ${JSON.stringify(originalPrompt)}`,
    imagePaths.length > 0
      ? `The original reference images remain binding visual evidence and are attached again in this exact host order: ${imagePaths.join(", ")}`
      : "The original request supplied no reference images; preserve the existing synthetic component vocabulary.",
    ...(evidenceImageCount > 0
      ? [
          `The final ${evidenceImageCount} attached image${evidenceImageCount === 1 ? " is a" : "s are"} rendered QA snapshot${evidenceImageCount === 1 ? "" : "s"} of the failing frames from this exact candidate — read-only pixel evidence of what the findings describe. Fix what the pixels show; do not restyle anything the snapshots prove healthy.`,
        ]
      : []),
    "The structured findings in sequences-author-context-json are the exact full host evidence for this turn:",
    ...lines,
    "For motion_selector_missing, make the assertion target a stable real element in the fully assembled DOM, or restore the intended missing element; do not delete the assertion to hide the failure.",
    "For motion_appears_late, repair the authored entrance so the intended subject is measurably visible by its claimed time, or correct that authored sidecar claim to the intended entrance; the host will not rewrite timing for you.",
    "For motion_frozen, give the asserted subject meaningful transform motion throughout the measured window while keeping the paused master timeline deterministic and seek-safe; do not point the assertion at an unrelated moving decoration.",
    "For motion_off_frame, keep the intended readable UI subject inside the 1920x1080 frame over its entire animated pose; do not retarget the assertion to a broad world/camera wrapper.",
    "For gsap_non_transform_motion, replace layout-property tweens with equivalent x/y/scale/rotation transform motion and preserve the designed resting geometry.",
    "For a runtime console_warning attributed to [data-composition-id], treat index.html as assembled-root attribution rather than proof that the entry file owns the warning. Inspect every literal GSAP selector in the declared composition files and make sure querySelectorAll would return at least one real element. In particular, `.item:nth-child(n)` tests the item's own sibling index; when rows are indexed, use `.row:nth-child(n) .item` instead.",
    "For readable text failing contrast during a transition sample, replace the crossfade with an atomic visibility swap at the boundary (one GSAP set of autoAlpha/visibility) so text is never composited semi-transparent over other content; do not merely recolor it.",
    'For overlapping tweens on one target and property, make the later tween start strictly after the earlier one ends, or add overwrite: "auto" to the later tween.',
    "Keep sequence.json and index.motion.json consistent with any timing you adjust. The host will restore this entire turn unless a full strict re-verify contains strictly fewer actionable findings and no layout regression. List only files changed during this repair turn in the final artifact inventory.",
  ].join("\n");
}

function auditPolishPrompt(
  report: NonNullable<RunReceiptV1["visualAudit"]>,
  originalPrompt: string,
): string {
  return [
    "One bounded visual-audit polish on the exact compositor thread.",
    `The original user brief remains binding: ${JSON.stringify(originalPrompt)}`,
    `Typed visual-audit evidence: ${JSON.stringify(report)}`,
    "Fix only the cited observation in the named frames, beats, entities, and time range. Preserve every locked story, brand, component, and unrelated motion decision.",
    "Do not redesign the film, change semantic timing, suppress QA, or alter a detector/assertion to hide the issue. Prefer one class-level source correction that preserves the established camera and transition grammar.",
    "List only files changed during this polish turn in the final artifact inventory.",
  ].join("\n");
}

export function layoutRepairProofScope(
  sequence: NonNullable<Awaited<ReturnType<typeof readSequenceArtifact>>>,
  cluster: LayoutClusterV1,
): RevisionScopeV1 {
  const repairedFiles = new Set(
    (cluster.sourceFiles ?? []).map((file) => file.replaceAll("\\", "/").replace(/^\.\//, "")),
  );
  const targets = new Set([
    ...cluster.beatIds,
    ...sequence.beats
      .filter((beat) =>
        (beat.implementationFiles ?? []).some((file) =>
          repairedFiles.has(file.replaceAll("\\", "/").replace(/^\.\//, "")),
        ),
      )
      .map((beat) => beat.id),
  ]);
  return {
    targetBeatIds: [...targets],
    targetEntityIds: [],
    unchangedProofs: sequence.beats
      .filter((beat) => !targets.has(beat.id))
      .flatMap((beat) =>
        beat.proofTimes[0] === undefined ? [] : [{ beatId: beat.id, time: beat.proofTimes[0] }],
      )
      .filter(
        (proof) =>
          proof.time < cluster.timeRange[0] - 0.001 || proof.time > cluster.timeRange[1] + 0.001,
      ),
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function optionalLayoutInspection(
  runRoot: string,
  cluster: LayoutClusterV1,
): Promise<z.infer<typeof LayoutInspectionV1Schema> | null> {
  try {
    const inspectionFile = await existingFileWithin(runRoot, cluster.artifacts.inspection);
    return LayoutInspectionV1Schema.parse(
      JSON.parse(await readFile(inspectionFile, "utf8")) as unknown,
    );
  } catch (error) {
    if (isMissing(error) || (error instanceof ApiProblem && error.code === "file_not_found")) {
      return null;
    }
    throw error;
  }
}

/**
 * Rendered snapshots for the bounded residual-QA polish turn, adopted from the
 * donor's thumbnails-to-same-thread self-review: residual-warning fixes are
 * made against pixels, not descriptions. Purely additive evidence — when no
 * snapshot exists the turn proceeds on structured findings alone.
 */
export async function qaSnapshotEvidence(
  runRoot: string,
  qaArtifact: string,
  limit = 3,
): Promise<{ evidenceImages: string[]; evidenceImagePaths: string[] }> {
  const evidenceImages: string[] = [];
  const evidenceImagePaths: string[] = [];
  const snapshotRelative = qaArtifact.replace(/\/qa\.json$/, "/snapshots");
  if (snapshotRelative === qaArtifact) return { evidenceImages, evidenceImagePaths };
  try {
    const snapshots = (await readdir(join(runRoot, snapshotRelative)))
      .filter((name) => /\.png$/i.test(name))
      .sort((left, right) => {
        const priority = (name: string) =>
          /^finding-/i.test(name) ? 0 : /^frame-/i.test(name) ? 1 : 2;
        return priority(left) - priority(right) || left.localeCompare(right);
      })
      .slice(0, Math.max(1, limit));
    for (const snapshot of snapshots) {
      const artifact = `${snapshotRelative}/${snapshot}`;
      evidenceImagePaths.push(await existingFileWithin(runRoot, artifact));
      evidenceImages.push(artifact);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return { evidenceImages, evidenceImagePaths };
}

export async function layoutRepairEvidence(
  runRoot: string,
  qaArtifact: string,
  cluster: LayoutClusterV1,
): Promise<{ evidenceImages: string[]; evidenceImagePaths: string[] }> {
  const evidenceImages: string[] = [];
  const evidenceImagePaths: string[] = [];
  for (const artifact of [cluster.artifacts.fullFrame, cluster.artifacts.crop]) {
    try {
      evidenceImagePaths.push(await existingFileWithin(runRoot, artifact));
      evidenceImages.push(artifact);
    } catch (error) {
      if (!isMissing(error) && !(error instanceof ApiProblem && error.code === "file_not_found")) {
        throw error;
      }
    }
  }
  if (evidenceImages.length > 0) return { evidenceImages, evidenceImagePaths };

  const snapshotRelative = qaArtifact.replace(/\/qa\.json$/, "/snapshots");
  if (snapshotRelative === qaArtifact) return { evidenceImages, evidenceImagePaths };
  const snapshotRoot = join(runRoot, snapshotRelative);
  try {
    const snapshots = (await readdir(snapshotRoot))
      .filter((name) => /\.png$/i.test(name))
      .sort((left, right) => {
        const priority = (name: string) =>
          /^finding-/i.test(name) ? 0 : /^frame-/i.test(name) ? 1 : 2;
        return priority(left) - priority(right) || left.localeCompare(right);
      })
      .slice(0, 2);
    for (const snapshot of snapshots) {
      const artifact = `${snapshotRelative}/${snapshot}`;
      evidenceImagePaths.push(await existingFileWithin(runRoot, artifact));
      evidenceImages.push(artifact);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (evidenceImages.length === 0) {
    // The repair ledger requires an image input even when a verifier could not
    // capture the failing frame. Keep that exceptional path deterministic; the
    // structured QA findings and inspection context remain the repair authority.
    const fallbackName = "layout-evidence-unavailable.png";
    const fallbackArtifact = `${snapshotRelative}/${fallbackName}`;
    await mkdir(snapshotRoot, { recursive: true });
    await writeFile(
      join(snapshotRoot, fallbackName),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X3CHVwAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    evidenceImagePaths.push(await existingFileWithin(runRoot, fallbackArtifact));
    evidenceImages.push(fallbackArtifact);
  }
  return { evidenceImages, evidenceImagePaths };
}

export async function ensurePlayerRuntime(candidateRoot: string): Promise<void> {
  const indexPath = await existingFileWithin(candidateRoot, "index.html");
  const runtimePath = await existingFileWithin(
    candidateRoot,
    "assets/vendor/hyperframe.runtime.iife.js",
  );
  void runtimePath;
  const html = await readFile(indexPath, "utf8");
  if (/hyperframe\.runtime\.iife\.js/i.test(html)) return;
  if (!/<\/body>/i.test(html)) {
    throw new Error("HyperFrames index.html is missing its closing body tag");
  }
  const normalized = html.replace(
    /<\/body>/i,
    '    <script src="./assets/vendor/hyperframe.runtime.iife.js"></script>\n  </body>',
  );
  await writeFile(indexPath, normalized, "utf8");
}

async function freshCompositionHtmlFiles(candidateRoot: string): Promise<string[]> {
  return [
    "index.html",
    ...(await freshAuthoredFiles(candidateRoot, ["compositions", "scenes"], /\.html?$/i)),
  ];
}

async function freshTimelineScriptFiles(candidateRoot: string): Promise<string[]> {
  return freshAuthoredFiles(
    candidateRoot,
    ["compositions", "scenes", "assets/derived"],
    /\.(?:m?js)$/i,
  );
}

async function freshStyleFiles(candidateRoot: string): Promise<string[]> {
  return freshAuthoredFiles(candidateRoot, ["compositions", "scenes", "assets/derived"], /\.css$/i);
}

async function freshAuthoredFiles(
  candidateRoot: string,
  directories: readonly string[],
  pattern: RegExp,
): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relativeDirectory: string): Promise<void> => {
    try {
      const entries = await readdir(join(candidateRoot, relativeDirectory), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const relativePath = join(relativeDirectory, entry.name).replaceAll("\\", "/");
        if (entry.isDirectory()) await walk(relativePath);
        else if (entry.isFile() && pattern.test(entry.name)) files.push(relativePath);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
  for (const directory of directories) await walk(directory);
  return files.sort();
}

/**
 * An element carrying the full clip signature (data-start, data-duration, and
 * data-track-index) is unambiguously intended as a timed clip; without
 * class="clip" HyperFrames ignores its timing and shows it for the whole
 * composition, and lint hard-fails the run. Composition roots declare their
 * own timing and are excluded; sub-composition hosts (data-composition-src)
 * are real clips and are included. One live Luna probe authored six correct
 * timed sections and failed only on this missing marker.
 */
/**
 * The pinned lint warns when a composition scopes its own styles or selectors
 * with its own [data-composition-id="X"] attribute, or keys a style rule from a
 * class carried only by that composition root. Runtime scoping turns either
 * form into a descendant selector that cannot match the root. Both lint hints
 * name the same exact replacement: the root's unique #id. The rewrite has one
 * right answer, so the host owns it. Left alone, the class blocks strict QA at
 * scale and poisons repair-adoption deltas — the live Forma specimen carried
 * 152 such findings, and a +1 fluctuation in that mass vetoed a layout repair
 * that had fixed every real error. Only self-references inside the declaring
 * file are rewritten; references to other compositions and class tokens reused
 * by descendants are intentionally untouched.
 */
export async function normalizeFreshCompositionSelfSelectors(candidateRoot: string): Promise<void> {
  const files = await freshCompositionHtmlFiles(candidateRoot);
  const contents = new Map<string, { path: string; html: string }>();
  for (const relativePath of files) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    contents.set(relativePath, { path: filePath, html: await readFile(filePath, "utf8") });
  }
  const allSources = [...contents.values()].map((entry) => entry.html).join("\n");
  for (const { path, html } of contents.values()) {
    const root = /<([a-z][\w:-]*)\b[^>]*\bdata-composition-id\s*=\s*(["'])([^"']+)\2[^>]*>/i.exec(
      html,
    );
    if (!root) continue;
    const compositionId = root[3]!;
    const doubleQuoted = `[data-composition-id="${compositionId}"]`;
    const singleQuoted = `[data-composition-id='${compositionId}']`;
    const rootClasses = (/\sclass\s*=\s*(["'])([^"']+)\1/i.exec(root[0])?.[2] ?? "")
      .split(/\s+/)
      .filter(Boolean);
    const uniqueRootClasses = rootClasses.filter(
      (className) => countHtmlClassToken(html, className) === 1,
    );
    const hasAttributeSelfSelector = html.includes(doubleQuoted) || html.includes(singleQuoted);
    const hasRootClassStyle = styleUsesRootClassSelector(html, uniqueRootClasses);
    if (!hasAttributeSelfSelector && !hasRootClassStyle) continue;
    // Require whitespace before `id` so the match is the real id attribute and
    // never the trailing "id" inside data-hf-id / data-composition-id.
    let rootId = /\sid\s*=\s*(["'])([^"']+)\1/i.exec(root[0])?.[2] ?? null;
    let normalized = html;
    if (!rootId) {
      // Derive the id the lint hint convention expects, but only when it is
      // globally unused — assembled sub-compositions must keep unique DOM ids.
      const derived = `${compositionId}-root`;
      if (new RegExp(`\\bid\\s*=\\s*(["'])${derived}\\1`, "i").test(allSources)) continue;
      const tag = root[0].replace(/^<([a-z][\w:-]*)/i, `<$1 id="${derived}"`);
      normalized = html.slice(0, root.index) + tag + html.slice(root.index + root[0].length);
      rootId = derived;
    }
    normalized = normalized
      .replaceAll(doubleQuoted, `#${rootId}`)
      .replaceAll(singleQuoted, `#${rootId}`);
    normalized = normalizeRootClassStyleSelectors(normalized, uniqueRootClasses, rootId);
    if (normalized !== html) await writeFile(path, normalized, "utf8");
  }
}

function countHtmlClassToken(html: string, className: string): number {
  let count = 0;
  for (const match of html.matchAll(/\sclass\s*=\s*(["'])([^"']+)\1/gi)) {
    count += match[2]!.split(/\s+/).filter((token) => token === className).length;
  }
  return count;
}

function styleUsesRootClassSelector(html: string, rootClasses: readonly string[]): boolean {
  if (rootClasses.length === 0) return false;
  const rootClassSet = new Set(rootClasses);
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const css = style[1]!.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{/g)) {
      const header = rule[1]!.trim();
      if (!header || header.startsWith("@")) continue;
      for (const selector of header.split(",")) {
        const leftmost = selector.trim().split(/[\s>+~]+/)[0] ?? "";
        if (
          (leftmost.match(/\.([\w-]+)/g) ?? []).some((token) => rootClassSet.has(token.slice(1)))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function normalizeRootClassStyleSelectors(
  html: string,
  rootClasses: readonly string[],
  rootId: string,
): string {
  if (rootClasses.length === 0) return html;
  const rootClassSet = new Set(rootClasses);
  return html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (_block, opening: string, css: string, closing: string) => {
      const normalizedCss = css.replace(/([^{}]+)\{/g, (rule, header: string) => {
        if (!header.trim() || header.trimStart().startsWith("@")) return rule;
        const normalizedHeader = header
          .split(",")
          .map((selector) => {
            const compound = /^(\s*)([^\s>+~]+)/.exec(selector);
            if (!compound) return selector;
            let insertedRootId = false;
            const normalizedCompound = compound[2]!.replace(
              /\.([\w-]+)/g,
              (token, className: string) => {
                if (!rootClassSet.has(className)) return token;
                if (insertedRootId) return "";
                insertedRootId = true;
                return `#${rootId}`;
              },
            );
            if (!insertedRootId) return selector;
            return `${compound[1]}${normalizedCompound}${selector.slice(compound[0].length)}`;
          })
          .join(",");
        return `${normalizedHeader}{`;
      });
      return `${opening}${normalizedCss}${closing}`;
    },
  );
}

export async function ensureFreshClipClasses(candidateRoot: string): Promise<void> {
  for (const relativePath of await freshCompositionHtmlFiles(candidateRoot)) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    const html = await readFile(filePath, "utf8");
    const normalized = html.replace(/<([a-z][\w:-]*)\b[^>]*>/gi, (tag) => {
      if (
        !/\bdata-start\s*=/i.test(tag) ||
        !/\bdata-duration\s*=/i.test(tag) ||
        !/\bdata-track-index\s*=/i.test(tag)
      ) {
        return tag;
      }
      if (/\bdata-composition-id\s*=/i.test(tag) && !/\bdata-composition-src\s*=/i.test(tag)) {
        return tag;
      }
      const classAttr = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(tag);
      if (classAttr) {
        const classes = classAttr[2]!.split(/\s+/).filter(Boolean);
        if (classes.includes("clip")) return tag;
        return tag.replace(
          classAttr[0],
          `class=${classAttr[1]}${["clip", ...classes].join(" ")}${classAttr[1]}`,
        );
      }
      return tag.replace(/^<([a-z][\w:-]*)/i, '<$1 class="clip"');
    });
    if (normalized !== html) await writeFile(filePath, normalized, "utf8");
  }
}

/**
 * HyperFrames tracks are exclusive timelines: two clips whose time ranges
 * overlap cannot occupy the same track, even when the elements are merely
 * stacked decorative layers. Fresh directors often express that stack with
 * DOM order and repeat track 0. Preserve every authored start/duration and
 * move only a colliding later clip to the first free track. Processing in DOM
 * order keeps the resulting layer order deterministic and makes the pass
 * idempotent.
 */
export async function normalizeFreshClipTracks(candidateRoot: string): Promise<void> {
  for (const relativePath of await freshCompositionHtmlFiles(candidateRoot)) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    const source = await readFile(filePath, "utf8");
    const assigned: Array<{ start: number; end: number; track: number }> = [];
    const normalized = source.replace(/<([a-z][\w:-]*)\b[^>]*>/gi, (tag) => {
      const classes = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2]?.split(/\s+/) ?? [];
      if (!classes.includes("clip")) return tag;
      if (/\bdata-composition-id\s*=/i.test(tag) && !/\bdata-composition-src\s*=/i.test(tag)) {
        return tag;
      }
      const startMatch = /\bdata-start\s*=\s*(["'])([^"']+)\1/i.exec(tag);
      const durationMatch = /\bdata-duration\s*=\s*(["'])([^"']+)\1/i.exec(tag);
      const trackMatch = /(\bdata-track-index\s*=\s*)(["'])(-?\d+)\2/i.exec(tag);
      if (!startMatch || !durationMatch || !trackMatch) return tag;
      const start = Number(startMatch[2]);
      const duration = Number(durationMatch[2]);
      const authoredTrack = Number(trackMatch[3]);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        !Number.isSafeInteger(authoredTrack) ||
        authoredTrack < 0
      ) {
        return tag;
      }
      const end = start + duration;
      let track = authoredTrack;
      while (
        assigned.some((clip) => clip.track === track && start < clip.end && clip.start < end)
      ) {
        track += 1;
      }
      assigned.push({ start, end, track });
      if (track === authoredTrack) return tag;
      return tag.replace(trackMatch[0], `${trackMatch[1]}${trackMatch[2]}${track}${trackMatch[2]}`);
    });
    if (normalized !== source) await writeFile(filePath, normalized, "utf8");
  }
}

export async function normalizeFreshCompositionRoots(
  candidateRoot: string,
  sequence?: SequenceArtifactV1,
): Promise<void> {
  for (const relativePath of await freshCompositionHtmlFiles(candidateRoot)) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    let html = await readFile(filePath, "utf8");
    html = html.replace(/\bdata-layer\s*=/gi, "data-track-index=");
    html = unwrapStaleFreshScaffold(html);
    const compositionId =
      relativePath === "index.html"
        ? "fresh-build"
        : `fresh-build-${relativePath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
    const hfId = `${compositionId}-root`;
    const format = sequence?.format ?? {
      width: 1920,
      height: 1080,
      fps: 30,
      targetDuration: 5,
    };
    const duration = defaultCompositionDuration(relativePath, sequence, format.targetDuration);
    const required = [
      ["data-hf-id", hfId],
      ["data-composition-id", compositionId],
      ["data-start", "0"],
      ["data-duration", `${duration}`],
      ["data-width", `${format.width}`],
      ["data-height", `${format.height}`],
      ["data-fps", `${format.fps}`],
    ] as const;
    const root =
      /<([a-z][\w:-]*)\b[^>]*\bid=(['"])root\2[^>]*>/i.exec(html) ??
      firstAuthoredCompositionRoot(html);
    if (root) {
      let tag = root[0];
      const forceTechnicalTiming = relativePath === "index.html" || isFreshScaffoldTag(tag);
      for (const [name, value] of required) {
        const existing = new RegExp(`(\\b${name}\\s*=\\s*)(["'])[^"']*\\2`, "i");
        if (forceTechnicalTiming && !["data-hf-id", "data-composition-id"].includes(name)) {
          tag = tag.replace(existing, `$1"${value}"`);
        } else if (!existing.test(tag)) {
          tag = tag.replace(/\s*\/?>$/, ` ${name}="${value}"$&`);
        }
      }
      html = html.slice(0, root.index) + tag + html.slice(root.index + root[0].length);
    } else {
      const wrapper = `<div id="root" ${required.map(([name, value]) => `${name}="${value}"`).join(" ")}>`;
      if (/<body\b[^>]*>/i.test(html) && /<\/body>/i.test(html)) {
        html = html.replace(/(<body\b[^>]*>)/i, `$1\n    ${wrapper}`);
        html = html.replace(/(<\/body>)/i, `    </div>\n  $1`);
      } else {
        html = `${wrapper}${html}</div>`;
      }
    }
    if (relativePath === "index.html") {
      html = ensureFreshEntryTimelineRegistration(html);
    }
    await writeFile(filePath, html, "utf8");
  }
}

/**
 * The entry document owns HyperFrames' top-level clock even when every visible
 * beat lives in a sub-composition. Directors occasionally replace the starter
 * shell and omit that technical empty timeline. Repair the exact missing
 * registry class before lint so the first authoritative verification can also
 * run the downstream browser check instead of spending an author turn merely
 * unblocking it.
 */
function ensureFreshEntryTimelineRegistration(html: string): string {
  if (/window\.__timelines\s*(?:=|\[)/.test(html)) return html;
  const root =
    /<([a-z][\w:-]*)\b[^>]*\bid=(["'])root\2[^>]*>/i.exec(html) ??
    firstAuthoredCompositionRoot(html);
  const compositionId = root
    ? /\bdata-composition-id\s*=\s*(["'])([^"']+)\1/i.exec(root[0])?.[2]
    : undefined;
  if (!compositionId) return html;
  const safeCompositionId = JSON.stringify(compositionId);
  const registration = [
    "<script>",
    "  window.__timelines = window.__timelines || {};",
    `  window.__timelines[${safeCompositionId}] = gsap.timeline({ paused: true, defaults: { overwrite: "auto" } });`,
    "</script>",
  ].join("\n");
  const runtimeScript =
    /<script\b[^>]*\bsrc\s*=\s*(["'])[^"']*hyperframe\.runtime\.iife\.js[^"']*\1[^>]*>/i;
  if (runtimeScript.test(html)) return html.replace(runtimeScript, `${registration}\n$&`);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${registration}\n</body>`);
  return `${html}\n${registration}\n`;
}

function unwrapStaleFreshScaffold(html: string): string {
  const literalRoot = /<([a-z][\w:-]*)\b[^>]*\bid=(["'])root\2[^>]*>/i.exec(html);
  if (!literalRoot || !isFreshScaffoldTag(literalRoot[0])) return html;
  const authoredRoot = firstAuthoredCompositionRoot(
    html.slice((literalRoot.index ?? 0) + literalRoot[0].length),
  );
  if (!authoredRoot) return html;
  const closing = matchingClosingTag(html, literalRoot.index ?? 0, literalRoot[1] ?? "div");
  if (!closing) return html;
  return (
    html.slice(0, literalRoot.index) +
    html.slice((literalRoot.index ?? 0) + literalRoot[0].length, closing.start) +
    html.slice(closing.end)
  );
}

function isFreshScaffoldTag(tag: string): boolean {
  return (
    /\bdata-composition-id\s*=\s*(["'])fresh-build(?:-[a-z0-9-]+)?\1/i.test(tag) &&
    /\bdata-hf-id\s*=\s*(["'])fresh-build(?:-[a-z0-9-]+)?\1/i.test(tag)
  );
}

function matchingClosingTag(
  html: string,
  openingIndex: number,
  tagName: string,
): { start: number; end: number } | null {
  const tags = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  tags.lastIndex = openingIndex;
  let depth = 0;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    if ((tag[1] ?? "").toLowerCase() !== tagName.toLowerCase()) continue;
    const closing = /^<\//.test(tag[0]);
    const selfClosing = /\/\s*>$/.test(tag[0]);
    if (!closing && !selfClosing) depth += 1;
    if (closing) depth -= 1;
    if (closing && depth === 0) {
      return { start: tag.index, end: tag.index + tag[0].length };
    }
  }
  return null;
}

function defaultCompositionDuration(
  relativePath: string,
  sequence: SequenceArtifactV1 | undefined,
  fallback: number,
): number {
  if (relativePath === "index.html" || !sequence) return fallback;
  const beats = sequence.beats.filter((beat) => beat.implementationFiles.includes(relativePath));
  if (beats.length === 0) return fallback;
  const first = Math.min(...beats.map((beat) => beat.start ?? 0));
  const last = Math.max(...beats.map((beat) => (beat.start ?? 0) + (beat.duration ?? 0)));
  return Math.max(0.001, last - first);
}

function firstAuthoredCompositionRoot(html: string): RegExpExecArray | null {
  const tags = html.matchAll(
    /<([a-z][\w:-]*)\b[^>]*\bdata-composition-id\s*=\s*(['"])[^"']+\2[^>]*>/gi,
  );
  for (const tag of tags) {
    if (/\bdata-composition-src\s*=/i.test(tag[0])) continue;
    return tag as RegExpExecArray;
  }
  return null;
}

export async function repairFreshGsapTransformConflicts(candidateRoot: string): Promise<void> {
  for (const relativePath of await freshCompositionHtmlFiles(candidateRoot)) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    let html = await readFile(filePath, "utf8");
    let changed = false;
    const rulePattern =
      /(#[-\w]+)\s*\{([^{}]*?\btransform\s*:\s*scale([XY])\(([^)]+)\)\s*;?[^{}]*?)\}/gi;
    const conflicts = [...html.matchAll(rulePattern)];
    for (const match of conflicts) {
      const selector = match[1];
      const axis = match[3];
      const initial = match[4];
      if (!selector || !axis || !initial) continue;
      const property = `scale${axis}`;
      const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tweenPattern = new RegExp(
        `\\.to\\(\\s*([\\"'])${escapedSelector}\\1\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*,`,
      );
      const tween = tweenPattern.exec(html);
      if (!tween || !new RegExp(`\\b${property}\\s*:`, "i").test(tween[2] ?? "")) continue;
      const quote = tween[1];
      const replacement = `.fromTo(${quote}${selector}${quote}, { ${property}: ${initial} }, {${tween[2]}},`;
      html = html.replace(tween[0], replacement);
      html = html.replace(
        match[0],
        match[0].replace(/\btransform\s*:\s*scale[XY]\([^)]*\)\s*;?/i, ""),
      );
      changed = true;
    }
    if (changed) await writeFile(filePath, html, "utf8");
  }
}

/**
 * Applies the small seek-safe lifecycle contract used by fresh SaaS builds:
 * timeline property collisions use GSAP overwrite semantics, entrance tweens
 * own their pre-cue hidden state, and an already-visible persistent selector is
 * not invoked again through a second fromTo starting at opacity 1.
 */
export async function normalizeFreshGsapLifecycle(candidateRoot: string): Promise<void> {
  const openingPersistentSelectors = await openingPersistentComponentSelectors(candidateRoot);
  for (const relativePath of await freshCompositionHtmlFiles(candidateRoot)) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    const source = await readFile(filePath, "utf8");
    const normalized = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (script) =>
      normalizeGsapLifecycleScript(script, openingPersistentSelectors),
    );
    if (normalized !== source) await writeFile(filePath, normalized, "utf8");
  }
  for (const relativePath of await freshTimelineScriptFiles(candidateRoot)) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    const source = await readFile(filePath, "utf8");
    const normalized = normalizeGsapLifecycleScript(source, openingPersistentSelectors);
    if (normalized !== source) await writeFile(filePath, normalized, "utf8");
  }
}

async function openingPersistentComponentSelectors(candidateRoot: string): Promise<Set<string>> {
  try {
    const sequence = await readSequenceArtifact(candidateRoot);
    const firstBeatId = sequence?.beats[0]?.id;
    if (!firstBeatId) return new Set();
    const plan = JSON.parse(
      await readFile(join(candidateRoot, "story", "component-plan.json"), "utf8"),
    ) as { components?: unknown };
    if (!Array.isArray(plan.components)) return new Set();
    return new Set(
      plan.components.flatMap((component) => {
        if (!component || typeof component !== "object") return [];
        const record = component as Record<string, unknown>;
        if (
          record.continuity !== "persistent" ||
          typeof record.rootHfId !== "string" ||
          !Array.isArray(record.usedInBeatIds) ||
          !record.usedInBeatIds.includes(firstBeatId)
        ) {
          return [];
        }
        return [`#${record.rootHfId}`];
      }),
    );
  } catch {
    // Legacy/revision specimens may not carry a fresh-build component plan.
    return new Set();
  }
}

/**
 * `elementsFromPoint()` excludes a subtree whose container declares
 * `pointer-events:none`. HyperFrames consequently (and correctly for hit-test
 * semantics) cannot prove that readable descendants sit above their visual
 * background, producing a wall of text_occluded findings. Keep pointer event
 * suppression on decorative layers, but restore normal hit testing on simple
 * id/class containers that actually own readable text.
 */
export async function normalizeReadablePointerEvents(candidateRoot: string): Promise<void> {
  for (const relativePath of await freshCompositionHtmlFiles(candidateRoot)) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    const source = await readFile(filePath, "utf8");
    const normalized = source.replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (_style, opening: string, css: string, closing: string) =>
        `${opening}${css.replace(
          /([^{}]+)\{([^{}]*)\}/g,
          (rule, selectorList: string, body: string) => {
            if (!/\bpointer-events\s*:\s*none\b/i.test(body)) return rule;
            const selectors = selectorList.split(",").map((selector) => selector.trim());
            if (!selectors.some((selector) => selectorOwnsReadableText(source, selector))) {
              return rule;
            }
            return `${selectorList}{${body.replace(
              /\bpointer-events\s*:\s*none\b/gi,
              "pointer-events: auto",
            )}}`;
          },
        )}${closing}`,
    );
    if (normalized !== source) await writeFile(filePath, normalized, "utf8");
  }
}

function selectorOwnsReadableText(html: string, selector: string): boolean {
  const identity = /^(#|\.)([-_a-zA-Z][\w-]*)$/.exec(selector);
  if (!identity) return false;
  const attribute = identity[1] === "#" ? "id" : "class";
  const value = identity[2] ?? "";
  const openings = html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi);
  for (const opening of openings) {
    const tag = opening[0];
    const rawAttribute = new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag)?.[2];
    if (!rawAttribute) continue;
    const matches =
      attribute === "id"
        ? rawAttribute === value
        : rawAttribute.split(/\s+/).some((token) => token === value);
    if (!matches) continue;
    const closing = matchingClosingTag(html, opening.index ?? 0, opening[1] ?? "div");
    if (!closing) continue;
    const innerStart = (opening.index ?? 0) + tag.length;
    const text = html
      .slice(innerStart, closing.start)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(?:[a-z]+|#\d+|#x[\da-f]+);/gi, " ")
      .trim();
    if (/[\p{L}\p{N}]/u.test(text)) return true;
  }
  return false;
}

function normalizeGsapLifecycleScript(
  script: string,
  openingPersistentSelectors: ReadonlySet<string>,
): string {
  let normalized = script.replace(
    /gsap\.timeline\(\s*(?:\{([^{}]*)\})?\s*\)/g,
    (full, body: string | undefined) => {
      if (body && /\bdefaults\s*:/.test(body)) return full;
      const options = (body ?? "").trim().replace(/,\s*$/, "");
      return `gsap.timeline({ ${options}${options ? ", " : ""}defaults: { overwrite: "auto" } })`;
    },
  );
  normalized = normalizeFutureVisibilitySets(normalized);
  normalized = normalizeOpeningPersistentEntrances(normalized, openingPersistentSelectors);
  const seenFromTo = new Set<string>();
  normalized = normalized.replace(
    /([A-Za-z_$][\w$]*)\.fromTo\(\s*(["'])([^"']+)\2\s*,\s*\{([^{}]*)\}\s*,\s*\{([^{}]*)\}/g,
    (
      _full,
      timeline: string,
      quote: string,
      selector: string,
      fromBody: string,
      toBody: string,
    ) => {
      const key = `${timeline}\u0000${selector.trim()}`;
      const cleanedTo = removeFalseImmediateRender(toBody);
      const repeatedVisibleState = seenFromTo.has(key) && startsFromVisibleOpacity(fromBody);
      seenFromTo.add(key);
      if (repeatedVisibleState) {
        return `${timeline}.to(${quote}${selector}${quote}, {${cleanedTo}}`;
      }
      return `${timeline}.fromTo(${quote}${selector}${quote}, {${fromBody}}, {${cleanedTo}}`;
    },
  );
  return normalized;
}

function normalizeOpeningPersistentEntrances(
  script: string,
  selectors: ReadonlySet<string>,
): string {
  let normalized = script;
  for (const selector of selectors) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entrancePattern = new RegExp(
      `([A-Za-z_$][\\w$]*)\\.fromTo\\(\\s*(["'])${escapedSelector}\\2\\s*,\\s*\\{([^{}]*)\\}\\s*,\\s*\\{([^{}]*)\\}\\s*,\\s*([^)]+?)\\s*\\)\\s*;?`,
      "g",
    );
    normalized = normalized.replace(
      entrancePattern,
      (full, timeline: string, quote: string, fromBody: string, toBody: string) => {
        if (!startsFromHiddenOpacity(fromBody) || !endsAtVisibleOpacity(toBody)) return full;
        const landedBody = toBody
          .split(",")
          .filter(
            (entry) =>
              !/^\s*(?:duration|ease|delay|stagger|immediateRender|overwrite)\s*:/i.test(entry),
          )
          .join(",")
          .trim()
          .replace(/,\s*$/, "");
        return `${timeline}.set(${quote}${selector}${quote}, { ${landedBody} }, 0);`;
      },
    );
  }
  return normalized;
}

function startsFromHiddenOpacity(body: string): boolean {
  const autoAlpha = numericGsapProperty(body, "autoAlpha");
  const opacity = numericGsapProperty(body, "opacity");
  return (autoAlpha !== null && autoAlpha <= 0.01) || (opacity !== null && opacity <= 0.01);
}

function endsAtVisibleOpacity(body: string): boolean {
  const autoAlpha = numericGsapProperty(body, "autoAlpha");
  const opacity = numericGsapProperty(body, "opacity");
  return (autoAlpha !== null && autoAlpha >= 0.5) || (opacity !== null && opacity >= 0.5);
}

/**
 * GSAP zero-duration `set()` calls can materialize a future visible state while
 * a paused timeline is being constructed. A later seek then retains that
 * captured visible state before its cue, which makes mutually exclusive UI
 * layers render on top of each other. Convert only future visibility reveals
 * into a tiny explicit hidden-to-visible tween. The from-state is therefore
 * owned by the timeline at every pre-cue seek and the authored reveal remains
 * effectively instantaneous (one millisecond).
 */
function normalizeFutureVisibilitySets(script: string): string {
  return script.replace(
    /([A-Za-z_$][\w$]*)\.set\(\s*(["'])([^"']+)\2\s*,\s*\{([^{}]*)\}\s*,\s*([^)]+?)\s*\)/g,
    (full, timeline: string, quote: string, selector: string, body: string, position: string) => {
      if (isZeroTimelinePosition(position)) return full;
      const fromBody = hiddenStateForVisibilityReveal(body);
      if (!fromBody || /(?:^|,)\s*duration\s*:/i.test(body)) return full;
      const authoredBody = body.trim().replace(/,\s*$/, "");
      const ease = /(?:^|,)\s*ease\s*:/i.test(authoredBody) ? "" : ', ease: "none"';
      return `${timeline}.fromTo(${quote}${selector}${quote}, { ${fromBody} }, { ${authoredBody}${authoredBody ? ", " : ""}duration: 0.001${ease} }, ${position.trim()})`;
    },
  );
}

function isZeroTimelinePosition(position: string): boolean {
  const normalized = position.trim().replace(/^(["'])(.*)\1$/, "$2");
  return /^(?:0+(?:\.0*)?|\.0+)$/.test(normalized);
}

function hiddenStateForVisibilityReveal(body: string): string | null {
  const properties: string[] = [];
  const display = /\bdisplay\s*:\s*(["'])([^"']+)\1/i.exec(body)?.[2]?.toLowerCase();
  if (display && display !== "none") properties.push('display: "none"');

  const autoAlpha = numericGsapProperty(body, "autoAlpha");
  const opacity = numericGsapProperty(body, "opacity");
  if (autoAlpha !== null && autoAlpha >= 0.5) {
    properties.push("autoAlpha: 0");
  } else if (opacity !== null && opacity >= 0.5) {
    properties.push("opacity: 0");
  }

  const visibility = /\bvisibility\s*:\s*(["'])visible\1/i.test(body);
  if (visibility && autoAlpha === null) properties.push('visibility: "hidden"');
  return properties.length > 0 ? properties.join(", ") : null;
}

function numericGsapProperty(body: string, property: string): number | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|,)\\s*${escaped}\\s*:\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))\\s*(?:,|$)`,
    "i",
  ).exec(body);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function removeFalseImmediateRender(body: string): string {
  return body
    .split(",")
    .filter((entry) => !/^\s*immediateRender\s*:\s*false\s*$/i.test(entry))
    .join(",");
}

function startsFromVisibleOpacity(body: string): boolean {
  for (const entry of body.split(",")) {
    const match = /^\s*(?:opacity|autoAlpha)\s*:\s*(-?(?:\d+\.?\d*|\.\d+))\s*$/i.exec(entry);
    if (match && Number(match[1]) >= 0.5) return true;
  }
  return false;
}

export async function scopeFreshGsapSelectors(candidateRoot: string): Promise<void> {
  for (const relativePath of await freshCompositionHtmlFiles(candidateRoot)) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    const source = await readFile(filePath, "utf8");
    const html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, scopeTimelineScript);
    if (html !== source) await writeFile(filePath, html, "utf8");
  }
  for (const relativePath of await freshTimelineScriptFiles(candidateRoot)) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    const source = await readFile(filePath, "utf8");
    const script = scopeTimelineScript(source);
    if (script !== source) await writeFile(filePath, script, "utf8");
  }
}

function scopeTimelineScript(script: string): string {
  let scopedScript = script;
  const registrations = [
    ...script.matchAll(/window\.__timelines\[\s*(["'])([^"']+)\1\s*\]\s*=\s*([A-Za-z_$][\w$]*)/g),
  ];
  for (const registration of registrations) {
    const timelineId = registration[2];
    const variable = registration[3];
    if (!timelineId || !variable) continue;
    const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selectorPattern = new RegExp(
      `(${escapedVariable}\\.(?:to|fromTo|from|set)\\(\\s*)(["'])([^"']+)\\2`,
      "g",
    );
    scopedScript = scopedScript.replace(
      selectorPattern,
      (full, prefix: string, quote: string, selector: string) => {
        const scope =
          quote === '"'
            ? `[data-composition-id='${timelineId}'] `
            : `[data-composition-id="${timelineId}"] `;
        const scoped = scopeSelectorList(selector, scope);
        return scoped === selector ? full : `${prefix}${quote}${scoped}${quote}`;
      },
    );
  }
  return scopedScript;
}

function scopeSelectorList(selector: string, scope: string): string {
  const arms: string[] = [];
  let start = 0;
  let roundDepth = 0;
  let squareDepth = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") roundDepth += 1;
    if (character === ")") roundDepth = Math.max(0, roundDepth - 1);
    if (character === "[") squareDepth += 1;
    if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
    if (character === "," && roundDepth === 0 && squareDepth === 0) {
      arms.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  arms.push(selector.slice(start));
  return arms
    .map((arm) => {
      const trimmed = arm.trim();
      if (
        trimmed.length === 0 ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("[data-composition-id=")
      ) {
        return trimmed;
      }
      return `${scope}${trimmed}`;
    })
    .join(", ");
}

const NONDETERMINISTIC_FONT_FALLBACKS = new Set([
  "ui-monospace",
  "sfmono-regular",
  "menlo",
  "monaco",
  "consolas",
  "liberation mono",
  "courier new",
]);

export async function normalizeFreshFontFallbacks(candidateRoot: string): Promise<void> {
  const sourceFiles = [
    ...(await freshCompositionHtmlFiles(candidateRoot)),
    ...(await freshStyleFiles(candidateRoot)),
  ];
  for (const relativePath of [...new Set(sourceFiles)].sort()) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    const source = await readFile(filePath, "utf8");
    const html = source.replace(/(font-family\s*:\s*)([^;}]+)/gi, (full, prefix, value) => {
      const families = String(value)
        .split(",")
        .map((family) => family.trim())
        .filter(Boolean);
      const deterministic = families.filter((family) => {
        const normalized = family
          .replace(/^["']|["']$/g, "")
          .trim()
          .toLowerCase();
        return !NONDETERMINISTIC_FONT_FALLBACKS.has(normalized);
      });
      if (deterministic.length === families.length) return full;
      if (
        !deterministic.some((family) => /^(monospace|sans-serif|serif|system-ui)$/i.test(family))
      ) {
        deterministic.push("monospace");
      }
      return `${prefix}${deterministic.join(", ")}`;
    });
    if (html !== source) await writeFile(filePath, html, "utf8");
  }
}

export async function ensureFreshGsapTargets(candidateRoot: string): Promise<void> {
  for (const relativePath of await freshCompositionHtmlFiles(candidateRoot)) {
    const filePath = await existingFileWithin(candidateRoot, relativePath);
    let html = await readFile(filePath, "utf8");
    const selectors = new Set<string>();
    const selectorPattern =
      /(?:[A-Za-z_$][\w$]*\.(?:to|fromTo|from|set)|gsap\.utils\.toArray)\(\s*(["'])([^"']+)\1/g;
    for (const match of html.matchAll(selectorPattern)) {
      for (const id of match[2]?.matchAll(/#([A-Za-z][\w-]*)/g) ?? []) {
        if (id[1]) selectors.add(id[1]);
      }
    }
    let changed = false;
    for (const id of selectors) {
      if (
        new RegExp(`\\sid=["']${id.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}["']`, "i").test(
          html,
        )
      )
        continue;
      const escaped = id.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
      const byIdentity = new RegExp(`(<[a-z][^>]*\\bdata-hf-id=["']${escaped}["'][^>]*>)`, "i");
      const byClass = new RegExp(
        `(<[a-z][^>]*\\bclass=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>)`,
        "i",
      );
      const target = byIdentity.exec(html) ?? byClass.exec(html);
      if (!target || !target[1]) continue;
      const existingId = /\sid=["']([^"']+)["']/i.exec(target[1])?.[1];
      if (existingId) {
        const selector = `#${id}`;
        const replacementSelector = `#${existingId}`;
        html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (script) =>
          script.replaceAll(selector, replacementSelector),
        );
        changed = true;
        continue;
      }
      const replacement = target[1].replace(/\s*\/?>(\s*)$/, ` id="${id}">$1`);
      html = html.replace(target[1], replacement);
      changed = true;
    }
    if (changed) await writeFile(filePath, html, "utf8");
  }
}

export async function normalizeRootAssetPaths(
  candidateRoot: string,
  changedFiles: readonly string[],
): Promise<void> {
  await Promise.all(
    changedFiles
      .filter((path) => /\.(?:css|html?|[cm]?[jt]sx?)$/i.test(path))
      .map(async (path) => {
        let filePath: string;
        try {
          filePath = await existingFileWithin(candidateRoot, path);
        } catch (error) {
          if (
            isMissing(error) ||
            (error instanceof ApiProblem && error.code === "file_not_found")
          ) {
            return;
          }
          throw error;
        }
        const source = await readFile(filePath, "utf8");
        const normalized = source.replace(/(?:\.\.\/)+(assets|capture|fonts)\//g, "$1/");
        if (normalized !== source) await writeFile(filePath, normalized, "utf8");
      }),
  );
}
