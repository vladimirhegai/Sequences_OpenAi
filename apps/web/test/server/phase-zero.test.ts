import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunReceiptV1Schema, type QaReceiptV1 } from "../../src/shared";
import {
  CodexRunner,
  type CodexRunRequest,
  type CodexRunResult,
} from "../../src/server/codex-runner";
import { createServerConfig } from "../../src/server/config";
import { HyperframesVerifier } from "../../src/server/hyperframes";
import { JobManager } from "../../src/server/job-manager";
import { ProjectStore } from "../../src/server/project-store";
import { RenderManager } from "../../src/server/render-manager";
import { RunStore } from "../../src/server/run-store";
import { SkillBundle } from "../../src/server/skills";
import { authorFreshBuildFixture, FRESH_BUILD_ARTIFACTS } from "./fresh-build-fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe("Phase 0 fixture candidate lifecycle", () => {
  it("checkpoints the exact accepted bytes before generation or render", async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-accepted-checkpoint-"));
    roots.push(tempRoot);
    const config = createServerConfig({
      workspaceRoot: root,
      acceptedRoot: join(tempRoot, "accepted"),
      seedRoot: join(root, "fixtures", "release-a"),
      candidatesRoot: join(tempRoot, "candidates"),
      runsRoot: join(tempRoot, "runs"),
      rendersRoot: join(tempRoot, "renders"),
      renderWorktreesRoot: join(tempRoot, "render-worktrees"),
    });
    const projects = new ProjectStore(config);
    await projects.initialize();
    const before = await projects.acceptedCommit();
    await appendFile(
      join(config.acceptedRoot, "index.html"),
      "\n<!-- local accepted edit -->\n",
      "utf8",
    );
    expect(await projects.acceptedIsClean()).toBe(false);

    const checkpoint = await projects.checkpointAcceptedChanges(
      "Checkpoint local accepted-source edits before test generation",
    );
    expect(checkpoint).not.toBe(before);
    expect(await projects.acceptedIsClean()).toBe(true);

    const jobId = `run_${"f".repeat(32)}`;
    const candidate = await projects.createCandidate(jobId, checkpoint);
    expect(await readFile(join(candidate, "index.html"), "utf8")).toContain("local accepted edit");
  });

  it("cancels a host render and never exposes its partial output", async () => {
    const sourceRoot = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-render-cancel-"));
    roots.push(tempRoot);
    const fakeCli = join(tempRoot, "node_modules", "hyperframes", "dist", "cli.js");
    await mkdir(join(fakeCli, ".."), { recursive: true });
    await writeFile(
      fakeCli,
      `console.log("25% rendering"); setInterval(() => {}, 1000);\n`,
      "utf8",
    );
    const seedRoot = join(tempRoot, "fixture");
    await cp(join(sourceRoot, "fixtures", "release-a"), seedRoot, { recursive: true });
    const config = createServerConfig({
      workspaceRoot: tempRoot,
      acceptedRoot: join(tempRoot, "accepted"),
      seedRoot,
      candidatesRoot: join(tempRoot, "candidates"),
      runsRoot: join(tempRoot, "runs"),
      rendersRoot: join(tempRoot, "renders"),
      renderWorktreesRoot: join(tempRoot, "render-worktrees"),
      hyperframesCommand: process.execPath,
    });
    const projects = new ProjectStore(config);
    await projects.initialize();
    const verifier = {
      verify: async () => ({ ok: true }),
      cancel: () => false,
    } as unknown as HyperframesVerifier;
    const renders = new RenderManager(config, projects, verifier);
    await renders.initialize();
    const started = await renders.start("release-a", {
      version: "sequences.start-render.v1",
      quality: "draft",
    });
    await waitForRenderState(renders, started.receipt.renderId, "rendering");
    const cancelling = await renders.cancel(started.receipt.renderId);
    expect(cancelling.receipt.cancelRequested).toBe(true);
    const cancelled = await waitForRenderState(renders, started.receipt.renderId, "cancelled");
    expect(cancelled.receipt.artifacts).toBeNull();
    await waitForMissing(projects.renderWorktreeRoot(started.receipt.renderId));
  }, 20_000);

  it("pins a versioned skill profile and verifies the copied candidate manifest", async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-skill-profile-"));
    roots.push(tempRoot);
    const config = createServerConfig({
      workspaceRoot: root,
      skillsRoot: join(root, ".agents", "skills"),
      skillsManifestPath: join(root, ".agents", "skills-manifest.json"),
    });
    const candidate = join(tempRoot, "candidate");
    await mkdir(candidate);
    const skills = new SkillBundle(config);
    const profile = await skills.listSkills();
    expect(profile.version).toBe("sequences.skill-profile.v1");
    expect(profile.defaultWorkflow).toBe("sequences-saas-launch");
    expect(profile.requiredSkills).toEqual([
      "hyperframes",
      "hyperframes-core",
      "sequences-saas-launch",
    ]);
    const installed = await skills.install(candidate);
    expect(installed.catalog.profileId).toBe(profile.profileId);
    expect((await skills.readSkill("hyperframes"))[0]?.path).toBe("hyperframes/SKILL.md");

    const copiedManifestPath = join(candidate, ".agents", "skills-manifest.json");
    const copied = JSON.parse(await readFile(copiedManifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    copied.profileId = "tampered-profile-v1";
    await writeFile(copiedManifestPath, `${JSON.stringify(copied, null, 2)}\n`, "utf8");
    await expect(skills.verifyInstalled(candidate, installed.digest)).rejects.toThrow(
      "protected Hyperframes skill bundle",
    );
  });

  it("auto-promotes a verified build and accepts an annotated scaffold deletion", async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-phase-zero-"));
    roots.push(tempRoot);
    const config = createServerConfig({
      workspaceRoot: root,
      agentWorkflowMode: "legacy",
      acceptedRoot: join(tempRoot, "accepted"),
      seedRoot: join(root, "fixtures", "release-a"),
      candidatesRoot: join(tempRoot, "candidates"),
      runsRoot: join(tempRoot, "runs"),
      rendersRoot: join(tempRoot, "renders"),
      renderWorktreesRoot: join(tempRoot, "render-worktrees"),
      skillsRoot: join(root, ".agents", "skills"),
      skillsManifestPath: join(root, ".agents", "skills-manifest.json"),
      registryManifestPath: join(root, ".agents", "registry", "registry.json"),
    });
    const projects = new ProjectStore(config);
    await projects.initialize();
    const runs = new RunStore(projects);
    const skills = new SkillBundle(config);
    const qa: QaReceiptV1 = {
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
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        await authorFreshBuildFixture(request.candidateRoot);
        return {
          final: {
            version: "sequences.codex-final.v1",
            intent: "Exercise the isolated fixture candidate lifecycle.",
            artifacts: [...FRESH_BUILD_ARTIFACTS],
            skillsUsed: ["hyperframes", "hyperframes-core", "sequences-saas-launch"],
            limitations: ["Fixture author; no paid model call."],
            proofTimes: [0],
          },
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          cliVersion: "codex-cli 0.0.0-test",
          sanitizedArguments: ["<fixture-author>"],
          stderr: "",
          threadId: "00000000-0000-4000-8000-000000000001",
          resumed: request.threadId !== null,
        };
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    const verifier = {
      verify: async () => qa,
      cancel: () => false,
    } as unknown as HyperframesVerifier;
    const manager = new JobManager(config, projects, runs, skills, codex, verifier);

    const initialCommit = await projects.acceptedCommit();
    const job = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Fixture-backed automatic build",
      baseCommit: initialCommit,
      directorMode: "reset",
    });
    const applied = await waitForState(manager, job.receipt.jobId, "applied");
    expect(applied.receipt.qa?.ok).toBe(true);
    expect(applied.receipt.candidateCommit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(applied.receipt.state).toBe("applied");
    expect(applied.receipt.decision).toBeNull();
    expect(applied.receipt.changedFiles).toContain("compositions/02-compose.html");
    expect(await projects.acceptedCommit()).toBe(applied.receipt.candidateCommit);
  }, 30_000);

  it("resumes an interrupted fresh-build promotion from its synthetic Git base", async () => {
    const root = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-promotion-recovery-"));
    roots.push(tempRoot);
    const config = createServerConfig({
      workspaceRoot: root,
      acceptedRoot: join(tempRoot, "accepted"),
      seedRoot: join(root, "fixtures", "release-a"),
      candidatesRoot: join(tempRoot, "candidates"),
      runsRoot: join(tempRoot, "runs"),
      rendersRoot: join(tempRoot, "renders"),
      renderWorktreesRoot: join(tempRoot, "render-worktrees"),
      skillsRoot: join(root, ".agents", "skills"),
      skillsManifestPath: join(root, ".agents", "skills-manifest.json"),
    });
    const projects = new ProjectStore(config);
    await projects.initialize();
    const runs = new RunStore(projects);
    const jobId = `run_${"a".repeat(32)}`;
    const originalAcceptedCommit = await projects.acceptedCommit();
    const { candidate, baseCommit } = await projects.createFreshCandidate(
      jobId,
      originalAcceptedCommit,
    );
    await appendFile(join(candidate, "index.html"), "\n<!-- recovered promotion -->\n", "utf8");
    const candidateCommit = await projects.createCandidateCommit(candidate, jobId);
    expect(await projects.acceptedCommit()).toBe(originalAcceptedCommit);
    const now = new Date().toISOString();
    await runs.create(
      RunReceiptV1Schema.parse({
        version: "sequences.run-receipt.v1",
        jobId,
        projectId: "release-a",
        kind: "build",
        state: "applying",
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        baseCommit,
        candidateRef: `candidate:${jobId}`,
        candidateCommit,
        acceptedCommit: null,
        patchSha256: null,
        inversePatchSha256: null,
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        codexCliVersion: "codex-cli test",
        sanitizedArguments: [],
        allowedPaths: ["index.html"],
        changedFiles: ["index.html"],
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
      }),
    );
    const manager = new JobManager(
      config,
      projects,
      runs,
      new SkillBundle(config),
      {} as CodexRunner,
      {} as HyperframesVerifier,
    );

    await manager.recoverInterruptedJobs();

    const recovered = await runs.get(jobId);
    expect(recovered.state).toBe("applied");
    expect(recovered.acceptedCommit).toBe(candidateCommit);
    expect(recovered.error).toBeNull();
  }, 30_000);
});

async function waitForState(manager: JobManager, jobId: string, expected: "applied") {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await manager.get(jobId);
    if (response.receipt.state === expected) return response;
    if (["failed", "cancelled", "timed_out"].includes(response.receipt.state)) {
      throw new Error(response.receipt.error?.message ?? `Job ended in ${response.receipt.state}`);
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRenderState(
  manager: RenderManager,
  renderId: string,
  expected: "rendering" | "cancelled",
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await manager.get(renderId);
    if (response.receipt.state === expected) return response;
    if (["failed", "completed"].includes(response.receipt.state)) {
      throw new Error(
        response.receipt.error?.message ?? `Render ended in ${response.receipt.state}`,
      );
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for render state ${expected}`);
}

async function waitForMissing(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for cleanup of ${path}`);
}
