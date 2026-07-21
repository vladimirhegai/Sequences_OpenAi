import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { QaReceiptV1 } from "../../src/shared";
import {
  CodexRunner,
  type CodexRunRequest,
  type CodexRunResult,
} from "../../src/server/codex-runner";
import { createServerConfig } from "../../src/server/config";
import { HyperframesVerifier } from "../../src/server/hyperframes";
import { elementsWithAttribute, parseHtmlEvidence } from "../../src/server/html-evidence";
import { JobManager } from "../../src/server/job-manager";
import { ProjectStore } from "../../src/server/project-store";
import { RunStore } from "../../src/server/run-store";
import { SkillBundle } from "../../src/server/skills";
import { authorFreshBuildFixture, FRESH_BUILD_ARTIFACTS } from "./fresh-build-fixture";

const roots: string[] = [];
const THREAD_IDS = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe("Phase 1 fresh-build continuity", () => {
  it("starts every prompt from a blank source and a new Luna thread", async () => {
    const workspace = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-phase-one-"));
    roots.push(tempRoot);
    const config = createServerConfig({
      workspaceRoot: workspace,
      agentWorkflowMode: "legacy",
      acceptedRoot: join(tempRoot, "accepted"),
      seedRoot: join(workspace, "fixtures", "release-a"),
      candidatesRoot: join(tempRoot, "candidates"),
      runsRoot: join(tempRoot, "runs", "release-a"),
      rendersRoot: join(tempRoot, "renders"),
      renderWorktreesRoot: join(tempRoot, "render-worktrees"),
      skillsRoot: join(workspace, ".agents", "skills"),
      skillsManifestPath: join(workspace, ".agents", "skills-manifest.json"),
      registryManifestPath: join(workspace, ".agents", "registry", "registry.json"),
    });
    const projects = new ProjectStore(config);
    await projects.initialize();
    const runs = new RunStore(projects);
    const skills = new SkillBundle(config);
    const observedThreads: Array<string | null> = [];
    let call = 0;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        const threadId = THREAD_IDS[call] ?? THREAD_IDS[0]!;
        call += 1;
        observedThreads.push(request.threadId);
        const source = await readFile(join(request.candidateRoot, "index.html"), "utf8");
        expect(source).not.toContain("phase-one build");
        await authorFreshBuildFixture(request.candidateRoot);
        return result(request, threadId, [...FRESH_BUILD_ARTIFACTS]);
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const verifier = {
      verify: async () => passingQa(),
      cancel: () => false,
    } as unknown as HyperframesVerifier;
    const manager = new JobManager(config, projects, runs, skills, codex, verifier);

    await expect(
      manager.start("release-a", {
        version: "sequences.start-job.v1",
        kind: "build",
        prompt: "Try to continue an earlier run.",
        baseCommit: await projects.acceptedCommit(),
        directorMode: "continue",
      }),
    ).rejects.toMatchObject({ code: "unsupported_job_mode" });

    const first = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Create the first independent video.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const firstApplied = await waitForApplied(manager, first.receipt.jobId, 30_000);
    expect(firstApplied.receipt.director).toMatchObject({
      threadId: THREAD_IDS[0],
      generation: 1,
      resumed: false,
    });

    const second = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Create a completely different second video.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const secondReady = await waitForApplied(manager, second.receipt.jobId, 30_000);
    expect(observedThreads).toEqual([null, null]);
    expect(secondReady.receipt.director).toMatchObject({
      threadId: THREAD_IDS[1],
      generation: 2,
      resumed: false,
      parentRunId: null,
    });
    expect(
      await readFile(join(projects.runRoot(second.receipt.jobId), "prompt.json"), "utf8"),
    ).toContain("Create a completely different second video.");
    const designReceipt = JSON.parse(
      await readFile(
        join(projects.runRoot(second.receipt.jobId), "design-capsule-receipt.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(designReceipt).toMatchObject({
      version: "sequences.design-capsule-receipt.v1",
      path: "story/design-capsule.json",
      id: "proof-workflow-design",
      origin: { kind: "catalog", catalogId: "signal-light" },
    });
    expect(designReceipt.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it("resumes the exact director thread once when the first author turn materializes nothing", async () => {
    const turns: CodexRunRequest[] = [];
    const threadId = THREAD_IDS[0]!;
    let call = 0;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push(request);
        if (request.artifactDirectory) {
          await mkdir(join(request.runRoot, request.artifactDirectory), { recursive: true });
        }
        if (call++ === 0) return incompleteResult(request, threadId);
        await authorFreshBuildFixture(request.candidateRoot);
        return result(request, threadId, [...FRESH_BUILD_ARTIFACTS]);
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const { manager, projects } = await createHarness(codex);

    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Recover the unfinished authoring turn into a complete video.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const applied = await waitForApplied(manager, started.receipt.jobId, 30_000);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ threadId: null });
    expect(turns[0]?.operation).toBeUndefined();
    expect(turns[1]).toMatchObject({
      threadId,
      operation: "author_recovery",
      artifactDirectory: "turns/author-recovery-1",
      imagePaths: [],
    });
    expect(turns[1]?.prompt).toContain("Authoring recovery on the exact same Luna director thread");
    expect(applied.receipt.director).toMatchObject({ threadId, resumed: true });

    const events = await manager.events(started.receipt.jobId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "authoring",
          tool: "codex",
          message: expect.stringContaining("resuming the exact thread once"),
        }),
      ]),
    );
  }, 120_000);

  it("resumes the exact director thread once after an authoring timeout", async () => {
    const turns: CodexRunRequest[] = [];
    const threadId = THREAD_IDS[0]!;
    let call = 0;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push(request);
        if (request.artifactDirectory) {
          await mkdir(join(request.runRoot, request.artifactDirectory), { recursive: true });
        }
        if (call++ === 0) {
          return { ...incompleteResult(request, threadId), exitCode: 124, timedOut: true };
        }
        await authorFreshBuildFixture(request.candidateRoot);
        return {
          ...result(request, threadId, [...FRESH_BUILD_ARTIFACTS]),
          final: null,
          diskComplete: true,
        };
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const { manager, projects } = await createHarness(codex);

    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Resume the timed-out turn and finish the video.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const applied = await waitForApplied(manager, started.receipt.jobId, 30_000);

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      threadId,
      operation: "author_recovery",
      artifactDirectory: "turns/author-recovery-1",
    });
    expect(turns[1]?.prompt).toContain("exceeded the explicit job timeout");
    expect(applied.receipt.timedOut).toBe(false);
    expect(applied.receipt.director).toMatchObject({ threadId, resumed: true });
  }, 120_000);

  it("continues through the normal gates when recovery materializes a complete candidate before timing out", async () => {
    const turns: CodexRunRequest[] = [];
    const threadId = THREAD_IDS[0]!;
    let call = 0;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push(request);
        if (request.artifactDirectory) {
          await mkdir(join(request.runRoot, request.artifactDirectory), { recursive: true });
        }
        if (call++ === 0) return incompleteResult(request, threadId);
        await authorFreshBuildFixture(request.candidateRoot);
        return {
          ...incompleteResult(request, threadId),
          exitCode: 124,
          timedOut: true,
        };
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const { manager, projects } = await createHarness(codex);

    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Use the complete recovery files and still prove the final video through QA.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const applied = await waitForApplied(manager, started.receipt.jobId, 30_000);

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      threadId,
      operation: "author_recovery",
      artifactDirectory: "turns/author-recovery-1",
    });
    expect(applied.receipt).toMatchObject({
      state: "applied",
      timedOut: false,
      exitCode: 0,
      final: {
        version: "sequences.codex-final.v1",
        skillsUsed: ["hyperframes", "hyperframes-core", "sequences-saas-launch"],
      },
    });
    expect(applied.receipt.final?.artifacts).toEqual(
      expect.arrayContaining([
        "compositions/02-compose.html",
        "frame.md",
        "index.motion.json",
        "sequence.json",
        "story/component-plan.json",
        "story/design-capsule.json",
      ]),
    );
    const events = await manager.events(started.receipt.jobId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "authoring",
          tool: "filesystem",
          message: expect.stringContaining("complete disk candidate"),
        }),
      ]),
    );
  }, 120_000);

  it("salvages a complete first-turn disk candidate when the exact-thread recovery stalls without another write", async () => {
    const turns: CodexRunRequest[] = [];
    const threadId = THREAD_IDS[0]!;
    let call = 0;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push(request);
        if (request.artifactDirectory) {
          await mkdir(join(request.runRoot, request.artifactDirectory), { recursive: true });
        }
        if (call++ === 0) {
          await authorFreshBuildFixture(request.candidateRoot);
        }
        return {
          ...incompleteResult(request, threadId),
          exitCode: 124,
          timedOut: true,
        };
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const { manager, projects } = await createHarness(codex);

    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Keep the complete first-turn video even if its final response transport stalls.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const applied = await waitForApplied(manager, started.receipt.jobId, 30_000);

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      threadId,
      operation: "author_recovery",
      artifactDirectory: "turns/author-recovery-1",
    });
    expect(applied.receipt).toMatchObject({
      state: "applied",
      timedOut: false,
      exitCode: 0,
    });
    expect(applied.receipt.final?.artifacts).toEqual(
      expect.arrayContaining([...FRESH_BUILD_ARTIFACTS]),
    );
  }, 120_000);

  it.each([
    { label: "unchanged", writePartial: false },
    { label: "incomplete", writePartial: true },
  ])(
    "keeps an $label recovery without a final response terminal",
    async ({ writePartial }) => {
      const threadId = THREAD_IDS[0]!;
      let call = 0;
      const codex = {
        async run(request: CodexRunRequest): Promise<CodexRunResult> {
          if (request.artifactDirectory) {
            await mkdir(join(request.runRoot, request.artifactDirectory), { recursive: true });
          }
          if (call++ === 0) return incompleteResult(request, threadId);
          if (writePartial) {
            await writeFile(join(request.candidateRoot, "frame.md"), "partial recovery\n", "utf8");
          }
          return {
            ...incompleteResult(request, threadId),
            exitCode: 124,
            timedOut: true,
          };
        },
        cancel: () => false,
      } as unknown as CodexRunner;
      const { manager, projects } = await createHarness(codex);

      const started = await manager.start("release-a", {
        version: "sequences.start-job.v1",
        kind: "build",
        prompt: "Do not accept an incomplete recovery candidate.",
        baseCommit: await projects.acceptedCommit(),
        directorMode: "reset",
      });
      const terminal = await waitForTerminal(manager, started.receipt.jobId, 30_000);

      expect(terminal.receipt).toMatchObject({
        state: "timed_out",
        timedOut: true,
        error: { code: "codex_timed_out", owner: "codex" },
      });
      expect(terminal.receipt.final).toBeNull();
    },
    120_000,
  );

  it("reports independent host contract mismatches together and repairs them on one exact-thread turn", async () => {
    const turns: CodexRunRequest[] = [];
    const threadId = THREAD_IDS[1]!;
    let call = 0;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push(request);
        if (request.artifactDirectory) {
          await mkdir(join(request.runRoot, request.artifactDirectory), { recursive: true });
        }
        if (call++ === 0) {
          await authorFreshBuildFixture(request.candidateRoot);
          const componentPlanPath = join(request.candidateRoot, "story", "component-plan.json");
          const componentPlan = JSON.parse(await readFile(componentPlanPath, "utf8")) as {
            designCapsuleId: string;
          };
          componentPlan.designCapsuleId = "misbound-design";
          await writeFile(componentPlanPath, `${JSON.stringify(componentPlan, null, 2)}\n`, "utf8");
          const designCapsulePath = join(request.candidateRoot, "story", "design-capsule.json");
          const designCapsule = JSON.parse(await readFile(designCapsulePath, "utf8")) as {
            tokenBindings: { background: string };
          };
          designCapsule.tokenBindings.background = "--missing-background";
          await writeFile(designCapsulePath, `${JSON.stringify(designCapsule, null, 2)}\n`, "utf8");
          return result(request, threadId, [...FRESH_BUILD_ARTIFACTS]);
        }
        await authorFreshBuildFixture(request.candidateRoot);
        return result(request, threadId, [...FRESH_BUILD_ARTIFACTS]);
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const { manager, projects } = await createHarness(codex);

    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Repair a bounded fresh-build contract mismatch and finish the video.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const applied = await waitForApplied(manager, started.receipt.jobId, 30_000);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ threadId: null });
    expect(turns[1]).toMatchObject({
      threadId,
      operation: "contract_repair",
      artifactDirectory: "turns/contract-repair-1",
      imagePaths: [],
    });
    expect(turns[1]?.prompt).toContain(
      "story/component-plan.json designCapsuleId must bind to proof-workflow-design",
    );
    expect(turns[1]?.prompt).toContain(
      "background token --missing-background is not declared as #FDFAF3",
    );
    expect(applied.receipt.director).toMatchObject({ threadId, resumed: false });

    const acceptedPlan = JSON.parse(
      await readFile(
        join(projects.acceptedRoot("release-a"), "story", "component-plan.json"),
        "utf8",
      ),
    ) as { designCapsuleId: string };
    expect(acceptedPlan.designCapsuleId).toBe("proof-workflow-design");
    const turnFinal = JSON.parse(
      await readFile(
        join(projects.runRoot(started.receipt.jobId), "turns", "contract-repair-1", "final.json"),
        "utf8",
      ),
    ) as { artifacts: string[] };
    expect(turnFinal.artifacts).toContain("story/component-plan.json");

    const events = await manager.events(started.receipt.jobId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "authoring",
          tool: "contract-repair",
          message: expect.stringContaining("correcting it on the same thread (1/4)"),
        }),
      ]),
    );
  }, 120_000);

  it("normalizes an unambiguous sibling component part before contract recovery", async () => {
    const turns: CodexRunRequest[] = [];
    const threadId = THREAD_IDS[1]!;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push(request);
        await authorFreshBuildFixture(request.candidateRoot);
        const compositionPath = join(request.candidateRoot, "compositions", "02-compose.html");
        const part = '<h2 id="shell-main-title" data-hf-id="hf-shell-main-title">Overview</h2>';
        await writeFile(
          compositionPath,
          (await readFile(compositionPath, "utf8"))
            .replace(part, "")
            .replace('<section id="shell-window"', `${part}\n        <section id="shell-window"`),
          "utf8",
        );
        return result(request, threadId, [...FRESH_BUILD_ARTIFACTS]);
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const { manager, projects } = await createHarness(codex);

    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Normalize one objective component-containment mismatch.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    await waitForApplied(manager, started.receipt.jobId, 30_000);

    expect(turns).toHaveLength(1);
    const acceptedComposition = await readFile(
      join(projects.acceptedRoot("release-a"), "compositions", "02-compose.html"),
      "utf8",
    );
    const evidence = parseHtmlEvidence("compositions/02-compose.html", acceptedComposition);
    const rootMatch = elementsWithAttribute([evidence], "data-hf-id", "hf-shell-window")[0]!;
    const partMatch = elementsWithAttribute([evidence], "data-hf-id", "hf-shell-main-title")[0]!;
    expect(rootMatch.element.contains(partMatch.element)).toBe(true);
    const events = await manager.events(started.receipt.jobId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "authoring",
          tool: "filesystem",
          message: expect.stringContaining("under the declared DOM owner"),
        }),
      ]),
    );
  }, 120_000);

  it("converges when dependent contract layers expose three different repair packets", async () => {
    const turns: CodexRunRequest[] = [];
    const threadId = THREAD_IDS[1]!;
    let call = 0;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push(request);
        if (request.artifactDirectory) {
          await mkdir(join(request.runRoot, request.artifactDirectory), { recursive: true });
        }
        await authorFreshBuildFixture(request.candidateRoot);
        if (call === 0) {
          const componentPlanPath = join(request.candidateRoot, "story", "component-plan.json");
          const componentPlan = JSON.parse(await readFile(componentPlanPath, "utf8")) as {
            designCapsuleId: string;
          };
          componentPlan.designCapsuleId = "serial-component-mismatch";
          await writeFile(componentPlanPath, `${JSON.stringify(componentPlan, null, 2)}\n`, "utf8");
        } else if (call === 1) {
          const designCapsulePath = join(request.candidateRoot, "story", "design-capsule.json");
          const designCapsule = JSON.parse(await readFile(designCapsulePath, "utf8")) as {
            tokenBindings: { background: string };
          };
          designCapsule.tokenBindings.background = "--serial-missing-background";
          await writeFile(designCapsulePath, `${JSON.stringify(designCapsule, null, 2)}\n`, "utf8");
        } else if (call === 2) {
          const sequencePath = join(request.candidateRoot, "sequence.json");
          const sequence = JSON.parse(await readFile(sequencePath, "utf8")) as {
            version: string;
          };
          sequence.version = "sequences.invalid.v1";
          await writeFile(sequencePath, `${JSON.stringify(sequence, null, 2)}\n`, "utf8");
        }
        call += 1;
        return result(request, threadId, [...FRESH_BUILD_ARTIFACTS]);
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const { manager, projects } = await createHarness(codex);

    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Converge a fresh build across dependent contract layers.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    await waitForApplied(manager, started.receipt.jobId, 45_000);

    expect(turns).toHaveLength(4);
    expect(turns.slice(1).map((turn) => turn.artifactDirectory)).toEqual([
      "turns/contract-repair-1",
      "turns/contract-repair-2",
      "turns/contract-repair-3",
    ]);
    expect(turns.slice(1).every((turn) => turn.threadId === threadId)).toBe(true);
    expect(turns[3]?.prompt).toContain("Fresh-build contract repair 3 of 4");
  }, 120_000);

  it("stops contract recovery when a repair leaves the authoritative failure packet unchanged", async () => {
    const turns: CodexRunRequest[] = [];
    const threadId = THREAD_IDS[1]!;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push(request);
        if (request.artifactDirectory) {
          await mkdir(join(request.runRoot, request.artifactDirectory), { recursive: true });
        }
        if (turns.length === 1) {
          await authorFreshBuildFixture(request.candidateRoot);
          const componentPlanPath = join(request.candidateRoot, "story", "component-plan.json");
          const componentPlan = JSON.parse(await readFile(componentPlanPath, "utf8")) as {
            designCapsuleId: string;
          };
          componentPlan.designCapsuleId = "unchanged-contract-mismatch";
          await writeFile(componentPlanPath, `${JSON.stringify(componentPlan, null, 2)}\n`, "utf8");
        } else {
          const indexPath = join(request.candidateRoot, "index.html");
          await writeFile(
            indexPath,
            `${await readFile(indexPath, "utf8")}\n<!-- repair touched disk but did not fix the contract -->\n`,
            "utf8",
          );
        }
        return result(request, threadId, [...FRESH_BUILD_ARTIFACTS]);
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const { manager, projects } = await createHarness(codex);

    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Stop a non-converging contract repair.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const terminal = await waitForTerminal(manager, started.receipt.jobId, 30_000);

    expect(terminal.receipt.state).toBe("failed");
    expect(terminal.receipt.error?.message).toContain(
      "Fresh-build contract repair made no objective progress",
    );
    expect(turns).toHaveLength(2);
  }, 120_000);
});

describe("Workflow V2 balanced ownership", () => {
  it("locks creative and component artifacts, composes once, and audits read-only", async () => {
    const workspace = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-balanced-workflow-"));
    roots.push(tempRoot);
    const config = createServerConfig({
      workspaceRoot: workspace,
      acceptedRoot: join(tempRoot, "accepted"),
      seedRoot: join(workspace, "fixtures", "release-a"),
      candidatesRoot: join(tempRoot, "candidates"),
      runsRoot: join(tempRoot, "runs", "release-a"),
      rendersRoot: join(tempRoot, "renders"),
      renderWorktreesRoot: join(tempRoot, "render-worktrees"),
      skillsRoot: join(workspace, ".agents", "skills"),
      skillsManifestPath: join(workspace, ".agents", "skills-manifest.json"),
      registryManifestPath: join(workspace, ".agents", "registry", "registry.json"),
      agentWorkflowMode: "balanced",
    });
    const projects = new ProjectStore(config);
    await projects.initialize();
    const turns: CodexRunRequest[] = [];
    let lockedSequence = "";
    let creativeDirectionCalls = 0;
    const threadByRole = {
      creative_director: "20000000-0000-4000-8000-000000000001",
      component_architect: "20000000-0000-4000-8000-000000000002",
      compositor: "20000000-0000-4000-8000-000000000003",
      visual_auditor: "20000000-0000-4000-8000-000000000004",
      legacy_director: "20000000-0000-4000-8000-000000000005",
    } as const;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push(request);
        if (request.artifactDirectory) {
          await mkdir(join(request.runRoot, request.artifactDirectory), { recursive: true });
        }
        const role = request.agentRole ?? "legacy_director";
        const threadId = threadByRole[role];
        if (role === "visual_auditor") {
          const frame = request.temporalEvidence?.frames[0];
          expect(frame?.judgment).toMatch(/^(?:transit|landed)$/);
          return {
            final: null,
            audit: {
              version: "sequences.visual-audit.v1",
              evidenceArtifact: "workflow/temporal-evidence.json",
              verdict: "repair",
              summary: "One localized camera landing can be improved.",
              findings: [
                {
                  id: "camera-landing",
                  severity: "minor",
                  category: "camera",
                  beatIds: frame?.beatId ? [frame.beatId] : [],
                  entityIds: frame?.entityIds.slice(0, 1) ?? [],
                  frameIds: frame ? [frame.id] : [],
                  timeRange: frame ? [frame.at, frame.at] : [0, 0],
                  observation: "The last camera settle is slightly abrupt.",
                  repairIntent: "Ease only the final compositor-owned landing.",
                },
              ],
            },
            exitCode: 0,
            timedOut: false,
            cancelled: false,
            cliVersion: "codex-cli 0.0.0-test",
            sanitizedArguments: ["<fixture-auditor>"],
            stderr: "",
            threadId,
            resumed: false,
          };
        }

        const compositionPath = join(request.candidateRoot, "compositions", "02-compose.html");
        const originalComposition = await readFile(compositionPath, "utf8");
        const originalPreproduction =
          role === "creative_director"
            ? {
                frame: await readFile(join(request.candidateRoot, "frame.md"), "utf8").catch(
                  () => null,
                ),
                designCapsule: await readFile(
                  join(request.candidateRoot, "story", "design-capsule.json"),
                  "utf8",
                ).catch(() => null),
                componentPlan: await readFile(
                  join(request.candidateRoot, "story", "component-plan.json"),
                  "utf8",
                ).catch(() => null),
              }
            : null;
        await authorFreshBuildFixture(request.candidateRoot);
        if (role === "creative_director" || role === "component_architect") {
          await writeFile(compositionPath, originalComposition, "utf8");
          await rm(join(request.candidateRoot, "index.motion.json"), { force: true });
        }
        if (role === "creative_director") {
          const creativeCall = creativeDirectionCalls++;
          const sequencePath = join(request.candidateRoot, "sequence.json");
          const sequence = JSON.parse(await readFile(sequencePath, "utf8"));
          sequence.concept.motionGrammar.push(
            "An operated pointer presses the product control",
            "One camera owner travels, settles, and holds on the product target",
          );
          sequence.beats[0].camera = {
            owner: "dom-world",
            targetEntityId: "workflow-panel",
            startPose: { x: 0, y: 0, z: 0, scale: 1, rotationX: 0, rotationY: 0, rotationZ: 0 },
            endPose: {
              x: 24,
              y: -16,
              z: 0,
              scale: 1.12,
              rotationX: 0,
              rotationY: 0,
              rotationZ: 0,
            },
            arrival: 0.8,
            settle: 1.1,
            hold: 1.5,
          };
          sequence.transitions[0] = {
            ...sequence.transitions[0],
            kind: "match-cut",
            duration: 0.2,
            outgoingEntityId: "workflow-panel",
            incomingEntityId: "workflow-panel",
          };
          await writeFile(sequencePath, `${JSON.stringify(sequence, null, 2)}\n`, "utf8");
          if (creativeCall === 0) {
            for (const [path, contents] of [
              ["frame.md", originalPreproduction!.frame],
              ["story/design-capsule.json", originalPreproduction!.designCapsule],
              ["story/component-plan.json", originalPreproduction!.componentPlan],
            ] as const) {
              const absolute = join(request.candidateRoot, path);
              if (contents === null) await rm(absolute, { force: true });
              else await writeFile(absolute, contents, "utf8");
            }
            return {
              ...result(request, threadId, ["sequence.json"]),
              final: null,
              exitCode: 1,
              timedOut: true,
              diskComplete: false,
            };
          }
          if (creativeCall === 1) {
            const designCapsulePath = join(request.candidateRoot, "story", "design-capsule.json");
            const designCapsule = JSON.parse(await readFile(designCapsulePath, "utf8")) as {
              origin: { kind: string; rationale?: string; catalogId?: string };
              palette: { accent: string; accentText: string };
            };
            designCapsule.origin = {
              kind: "bespoke",
              rationale: "Exercise creative-owned preproduction contrast repair.",
            };
            designCapsule.palette.accent = "#0D7BEA";
            designCapsule.palette.accentText = "#FFFFFF";
            await writeFile(
              designCapsulePath,
              `${JSON.stringify(designCapsule, null, 2)}\n`,
              "utf8",
            );
          }
          lockedSequence = await readFile(join(request.candidateRoot, "sequence.json"), "utf8");
          return result(request, threadId, [
            "frame.md",
            "sequence.json",
            "story/design-capsule.json",
            "story/component-plan.json",
          ]);
        }
        if (role === "component_architect") {
          return result(request, threadId, ["story/component-plan.json"]);
        }
        if (role === "compositor" && request.operation === "author") {
          await writeFile(
            compositionPath,
            (await readFile(compositionPath, "utf8")).replace(
              'data-state="ready"',
              'data-state="idle"',
            ),
            "utf8",
          );
          await writeFile(
            join(request.candidateRoot, "sequence.json"),
            '{"version":"sequences.invalid-compositor-edit.v1"}\n',
            "utf8",
          );
        }
        if (request.operation === "contract_repair") {
          await writeFile(
            join(request.candidateRoot, "story", "component-plan.json"),
            `${await readFile(join(request.candidateRoot, "story", "component-plan.json"), "utf8")} `,
            "utf8",
          );
        }
        if (request.operation === "audit_polish") {
          await writeFile(
            compositionPath,
            `${await readFile(compositionPath, "utf8")}\n<!-- bounded audit polish -->\n`,
            "utf8",
          );
          return {
            ...result(request, threadId, ["compositions/02-compose.html"]),
            final: null,
            diskComplete: true,
          };
        }
        return result(request, threadId, [...FRESH_BUILD_ARTIFACTS]);
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const verifier = {
      async verify(
        _jobId: string,
        _candidateRoot: string,
        runRoot: string,
        options: { artifactDirectory?: string },
      ) {
        const snapshotRoot = join(
          runRoot,
          options.artifactDirectory ?? "qa/attempt-1",
          "snapshots",
        );
        await mkdir(snapshotRoot, { recursive: true });
        await writeFile(
          join(snapshotRoot, "frame-00-at-2.0s.png"),
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X3CHVwAAAABJRU5ErkJggg==",
            "base64",
          ),
        );
        return passingQa();
      },
      async captureTemporalSnapshots(
        _jobId: string,
        _candidateRoot: string,
        runRoot: string,
        times: readonly number[],
      ) {
        const snapshotRoot = join(runRoot, "workflow", "temporal-snapshots");
        await mkdir(snapshotRoot, { recursive: true });
        const evidenceImages: string[] = [];
        const evidenceImagePaths: string[] = [];
        for (const [index, time] of times.entries()) {
          const name = `frame-${String(index).padStart(2, "0")}-at-${time.toFixed(3)}s.png`;
          const absolutePath = join(snapshotRoot, name);
          await writeFile(
            absolutePath,
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X3CHVwAAAABJRU5ErkJggg==",
              "base64",
            ),
          );
          evidenceImages.push(`workflow/temporal-snapshots/${name}`);
          evidenceImagePaths.push(absolutePath);
        }
        return { evidenceImages, evidenceImagePaths, times: [...times] };
      },
      cancel: () => false,
    } as unknown as HyperframesVerifier;
    const manager = new JobManager(
      config,
      projects,
      new RunStore(projects),
      new SkillBundle(config),
      codex,
      verifier,
    );

    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Launch a Liquid Glass workflow whose result morphs into proof.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const applied = await waitForApplied(manager, started.receipt.jobId, 45_000);

    expect(turns.map((turn) => turn.agentRole)).toEqual([
      "creative_director",
      "creative_director",
      "creative_director",
      "compositor",
      "compositor",
      "visual_auditor",
      "compositor",
    ]);
    expect(turns.map((turn) => turn.operation)).toEqual([
      "creative_direction",
      "creative_direction",
      "creative_direction",
      "author",
      "contract_repair",
      "visual_audit",
      "audit_polish",
    ]);
    expect(turns[0]?.allowedPaths).toEqual([
      "frame.md",
      "sequence.json",
      "story/design-capsule.json",
      "story/component-plan.json",
    ]);
    expect(turns[1]).toMatchObject({
      threadId: threadByRole.creative_director,
      operation: "creative_direction",
      artifactDirectory: "turns/workflow-creative-direction-retry-1",
    });
    expect(turns[2]).toMatchObject({
      threadId: threadByRole.creative_director,
      operation: "creative_direction",
      artifactDirectory: "turns/workflow-creative-direction-contract-repair-1",
    });
    expect(turns[2]?.prompt).toContain("accentText/accent contrast 4.17 is below 4.5:1");
    expect(turns[3]?.allowedPaths).not.toContain("sequence.json");
    expect(turns[3]?.allowedPaths).not.toContain("story/component-plan.json");
    expect(turns[4]?.allowedPaths).not.toContain("story/component-plan.json");
    expect(turns[5]?.allowedPaths).toEqual([]);
    expect(turns[6]).toMatchObject({
      threadId: threadByRole.compositor,
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    const compositorCapabilities = turns
      .find((turn) => turn.agentRole === "compositor" && turn.operation === "author")
      ?.authorContext.capabilities.map(({ id }) => id);
    expect(compositorCapabilities).toEqual(
      expect.arrayContaining([
        "camera-targeting",
        "multi-phase-camera",
        "identity-morph",
        "product-cursor-action",
      ]),
    );
    expect(applied.receipt.model).toBe("gpt-5.6-terra");
    expect(applied.receipt.agentWorkflow).toMatchObject({
      mode: "balanced",
      componentSpecialist: true,
      compositorThreadId: threadByRole.compositor,
      temporalEvidenceArtifact: "workflow/temporal-evidence.json",
      visualAuditArtifact: "workflow/visual-audit.json",
    });
    expect(applied.receipt.agentWorkflow.turns.map((turn) => turn.role)).toEqual([
      "creative_director",
      "creative_director",
      "creative_director",
      "compositor",
      "compositor",
      "visual_auditor",
      "compositor",
    ]);
    expect(applied.receipt.director?.threadId).toBe(threadByRole.compositor);
    expect(applied.receipt.visualAudit?.verdict).toBe("repair");
    expect(
      await readFile(
        join(projects.acceptedRoot("release-a"), "compositions", "02-compose.html"),
        "utf8",
      ),
    ).toContain("bounded audit polish");
    expect(
      JSON.parse(await readFile(join(projects.acceptedRoot("release-a"), "sequence.json"), "utf8")),
    ).toEqual(JSON.parse(lockedSequence));
    const events = await manager.events(started.receipt.jobId);
    expect(events.some(({ message }) => message.includes("no remaining attempt"))).toBe(false);
    expect(events.some(({ tool }) => tool === "workflow-custody")).toBe(true);
    expect(
      events.some(
        ({ tool, message }) => tool === "workflow-custody" && message.includes("sequence.json"),
      ),
    ).toBe(true);
  }, 120_000);
});

async function createHarness(codex: CodexRunner) {
  const workspace = process.cwd();
  const tempRoot = await mkdtemp(join(tmpdir(), "sequences-phase-one-recovery-"));
  roots.push(tempRoot);
  const config = createServerConfig({
    workspaceRoot: workspace,
    agentWorkflowMode: "legacy",
    acceptedRoot: join(tempRoot, "accepted"),
    seedRoot: join(workspace, "fixtures", "release-a"),
    candidatesRoot: join(tempRoot, "candidates"),
    runsRoot: join(tempRoot, "runs", "release-a"),
    rendersRoot: join(tempRoot, "renders"),
    renderWorktreesRoot: join(tempRoot, "render-worktrees"),
    skillsRoot: join(workspace, ".agents", "skills"),
    skillsManifestPath: join(workspace, ".agents", "skills-manifest.json"),
    registryManifestPath: join(workspace, ".agents", "registry", "registry.json"),
  });
  const projects = new ProjectStore(config);
  await projects.initialize();
  const manager = new JobManager(
    config,
    projects,
    new RunStore(projects),
    new SkillBundle(config),
    codex,
    {
      verify: async () => passingQa(),
      cancel: () => false,
    } as unknown as HyperframesVerifier,
  );
  return { manager, projects };
}

function result(request: CodexRunRequest, threadId: string, artifacts: string[]): CodexRunResult {
  return {
    final: {
      version: "sequences.codex-final.v1",
      intent: "Create a completely new video.",
      artifacts,
      skillsUsed: ["hyperframes", "hyperframes-core", "sequences-saas-launch"],
      limitations: ["Fixture author; no paid model call."],
      proofTimes: [2],
    },
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    cliVersion: "codex-cli 0.0.0-test",
    sanitizedArguments: ["<fixture-author>"],
    stderr: "",
    threadId,
    resumed: request.threadId !== null,
  };
}

function incompleteResult(request: CodexRunRequest, threadId: string): CodexRunResult {
  return {
    final: null,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    cliVersion: "codex-cli 0.0.0-test",
    sanitizedArguments: ["<fixture-author>"],
    stderr: "",
    threadId,
    resumed: request.threadId !== null,
  };
}

function passingQa(): QaReceiptV1 {
  return {
    version: "sequences.qa-receipt.v1",
    hyperframesVersion: "0.7.56",
    ok: true,
    commands: [
      { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
      { command: "check", ok: true, exitCode: 0, durationMs: 1, artifact: "check.json" },
    ],
    summary: { errorCount: 0, warningCount: 0, infoCount: 0 },
    findings: [],
  };
}

async function waitForApplied(manager: JobManager, jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await manager.get(jobId);
    if (response.receipt.state === "applied") return response;
    if (["failed", "cancelled", "timed_out"].includes(response.receipt.state)) {
      throw new Error(response.receipt.error?.message ?? `Job ended in ${response.receipt.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for applied");
}

async function waitForTerminal(manager: JobManager, jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await manager.get(jobId);
    if (["failed", "cancelled", "timed_out", "stale"].includes(response.receipt.state)) {
      return response;
    }
    if (response.receipt.state === "applied") {
      throw new Error(`${jobId} unexpectedly applied`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${jobId} to terminate`);
}
