import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LayoutClusterV1, QaReceiptV1, SequenceArtifactV1 } from "../../src/shared";
import {
  CodexRunner,
  type CodexRunRequest,
  type CodexRunResult,
} from "../../src/server/codex-runner";
import { createServerConfig } from "../../src/server/config";
import { HyperframesVerifier } from "../../src/server/hyperframes";
import {
  actionableNonLayoutCount,
  ensurePlayerRuntime,
  hasLayoutRepairBudget,
  JobManager,
  layoutRepairEvidence,
  layoutRepairClusterBatch,
  layoutRepairFeedback,
  layoutRepairProofScope,
  normalizeRootAssetPaths,
  qaRepairAllowedPaths,
  qaSnapshotEvidence,
  reconcileCodexFinalArtifacts,
} from "../../src/server/job-manager";
import { ProjectStore } from "../../src/server/project-store";
import { ProofComparator } from "../../src/server/proof-comparator";
import { RunStore } from "../../src/server/run-store";
import { SkillBundle } from "../../src/server/skills";
import { authorFreshBuildFixture, FRESH_BUILD_ARTIFACTS } from "./fresh-build-fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 0 category remediation loop", () => {
  it("uses the verified Git diff as the final artifact inventory", () => {
    const reconciled = reconcileCodexFinalArtifacts(
      {
        version: "sequences.codex-final.v1",
        intent: "Author the launch film",
        artifacts: [],
        skillsUsed: ["hyperframes"],
        limitations: [],
        proofTimes: [2],
      },
      ["sequence.json", "index.html", "sequence.json"],
    );

    expect(reconciled.artifacts).toEqual(["index.html", "sequence.json"]);
    expect(reconciled.skillsUsed).toEqual(["hyperframes"]);
  });

  it("repairs related clusters from one composition as a class", () => {
    const cluster = (id: string, sourceFile: string) =>
      ({ id, sourceFiles: [sourceFile] }) as LayoutClusterV1;
    const batch = layoutRepairClusterBatch([
      cluster("layout-cluster-primary", "compositions/app.html"),
      cluster("layout-cluster-same-source", "compositions/app.html"),
      cluster("layout-cluster-other-source", "compositions/cta.html"),
    ]);

    expect(batch.map((item) => item.id)).toEqual([
      "layout-cluster-primary",
      "layout-cluster-same-source",
    ]);
  });

  it("retains a rejected renderer packet for the next layout retry", () => {
    const feedback = layoutRepairFeedback("Repair did not reduce the unresolved layout cluster", {
      ...passingQa(),
      ok: false,
      summary: { errorCount: 1, warningCount: 0, infoCount: 1 },
      findings: [
        {
          command: "check",
          category: "layout",
          code: "text_occluded",
          severity: "error",
          sourceFile: "compositions/02-compose.html",
          selector: "#product-topline",
          times: [0.345],
          message: "Topline is covered by the workspace header.",
          fixHint: null,
          artifact: "qa/attempt-2/check.json",
        },
        {
          command: "check",
          category: "layout",
          code: "canvas_overflow",
          severity: "info",
          sourceFile: "compositions/02-compose.html",
          selector: "#decorative-grid",
          times: [0.345],
          message: "Decorative grid exceeds the canvas.",
          fixHint: null,
          artifact: "qa/attempt-2/check.json",
        },
      ],
    });

    expect(feedback).toMatchObject({
      reason: "Repair did not reduce the unresolved layout cluster",
      findings: [{ code: "text_occluded", selector: "#product-topline" }],
    });
    expect(feedback.findings).toHaveLength(1);
  });

  it("opens declared composition files for an assembled-root runtime warning", () => {
    const finding = {
      category: "runtime",
      code: "console_warning",
      sourceFile: "index.html",
      selector: "[data-composition-id]",
    } as QaReceiptV1["findings"][number];
    const sequence = {
      beats: [
        {
          implementationFiles: ["compositions/02-compose.html"],
        },
      ],
    } as SequenceArtifactV1;

    expect(
      qaRepairAllowedPaths([finding], sequence, [
        "index.html",
        "index.motion.json",
        "sequence.json",
        "compositions/**",
      ]),
    ).toEqual(["compositions/02-compose.html", "index.html", "index.motion.json", "sequence.json"]);
  });

  it("reserves all three layout turns after the pre-layout deterministic budget", () => {
    expect(hasLayoutRepairBudget(1, 4)).toBe(true);
    expect(hasLayoutRepairBudget(2, 5)).toBe(true);
    expect(hasLayoutRepairBudget(3, 6)).toBe(true);
    expect(hasLayoutRepairBudget(4, 7)).toBe(false);
  });

  it("does not treat failed layout evidence capture as a candidate regression", () => {
    const qa = passingQa();
    qa.ok = false;
    qa.findings = [
      {
        command: "check",
        category: "layout_inspection",
        code: "layout_inspection_failed",
        severity: "error",
        sourceFile: "index.html",
        selector: null,
        times: [1],
        message: "No inspectable pair remained.",
        fixHint: null,
        artifact: "check.json",
      },
      {
        command: "check",
        category: "motion",
        code: "motion_frozen",
        severity: "error",
        sourceFile: "index.html",
        selector: "#panel",
        times: [1],
        message: "Panel did not move.",
        fixHint: null,
        artifact: "check.json",
      },
    ];

    expect(actionableNonLayoutCount(qa)).toBe(1);
  });

  it("falls back to strict-check snapshots when rich layout inspection artifacts are absent", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "sequences-layout-evidence-"));
    roots.push(runRoot);
    await mkdir(join(runRoot, "qa", "attempt-2", "snapshots"), { recursive: true });
    await writeFile(
      join(runRoot, "qa", "attempt-2", "snapshots", "finding-00-text_box_overflow.png"),
      "png",
    );

    const evidence = await layoutRepairEvidence(runRoot, "qa/attempt-2/qa.json", {
      artifacts: {
        inspection: "qa/attempt-2/layout/missing/inspection.json",
        fullFrame: "qa/attempt-2/layout/missing/full-frame.png",
        crop: "qa/attempt-2/layout/missing/crop.png",
      },
    } as LayoutClusterV1);

    expect(evidence.evidenceImages).toEqual([
      "qa/attempt-2/snapshots/finding-00-text_box_overflow.png",
    ]);
    expect(evidence.evidenceImagePaths[0]).toBe(
      join(runRoot, "qa", "attempt-2", "snapshots", "finding-00-text_box_overflow.png"),
    );
  });

  it("uses ordinary strict-check frames before creating a deterministic evidence placeholder", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "sequences-layout-frame-evidence-"));
    roots.push(runRoot);
    await mkdir(join(runRoot, "qa", "attempt-1", "snapshots"), { recursive: true });
    await writeFile(join(runRoot, "qa", "attempt-1", "snapshots", "frame-00-at-0.0s.png"), "png");

    const cluster = {
      artifacts: {
        inspection: "qa/attempt-1/layout/missing/inspection.json",
        fullFrame: "qa/attempt-1/layout/missing/full-frame.png",
        crop: "qa/attempt-1/layout/missing/crop.png",
      },
    } as LayoutClusterV1;
    const fromFrame = await layoutRepairEvidence(runRoot, "qa/attempt-1/qa.json", cluster);
    expect(fromFrame.evidenceImages).toEqual(["qa/attempt-1/snapshots/frame-00-at-0.0s.png"]);

    await rm(join(runRoot, "qa", "attempt-1", "snapshots"), { recursive: true });
    const fromPlaceholder = await layoutRepairEvidence(runRoot, "qa/attempt-1/qa.json", cluster);
    expect(fromPlaceholder.evidenceImages).toEqual([
      "qa/attempt-1/snapshots/layout-evidence-unavailable.png",
    ]);
    expect((await readFile(fromPlaceholder.evidenceImagePaths[0]!)).length).toBeGreaterThan(0);
  });

  it("prioritizes finding snapshots for residual QA polish evidence", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "sequences-qa-polish-evidence-"));
    roots.push(runRoot);
    const snapshotRoot = join(runRoot, "qa", "attempt-3", "snapshots");
    await mkdir(snapshotRoot, { recursive: true });
    await writeFile(join(snapshotRoot, "frame-00-at-0.0s.png"), "frame");
    await writeFile(join(snapshotRoot, "finding-00-motion_out_of_order.png"), "finding");
    await writeFile(join(snapshotRoot, "frame-01-at-3.8s.png"), "frame");

    const evidence = await qaSnapshotEvidence(runRoot, "qa/attempt-3/qa.json", 2);

    expect(evidence.evidenceImages).toEqual([
      "qa/attempt-3/snapshots/finding-00-motion_out_of_order.png",
      "qa/attempt-3/snapshots/frame-00-at-0.0s.png",
    ]);
    expect(evidence.evidenceImagePaths).toEqual(
      evidence.evidenceImages.map((artifact) => join(runRoot, ...artifact.split("/"))),
    );
  });

  it("normalizes composition asset URLs to the HyperFrames project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-root-assets-"));
    roots.push(root);
    await mkdir(join(root, "compositions"), { recursive: true });
    await writeFile(
      join(root, "compositions", "scene.html"),
      '<img src="../assets/photo.png"><style>@font-face{src:url(../../fonts/test.woff2)}</style>',
      "utf8",
    );

    await normalizeRootAssetPaths(root, ["compositions/scene.html"]);

    expect(await readFile(join(root, "compositions", "scene.html"), "utf8")).toBe(
      '<img src="assets/photo.png"><style>@font-face{src:url(fonts/test.woff2)}</style>',
    );
  });

  it("does not call a proof inside the reported repair interval unchanged", () => {
    const sequence = {
      beats: [
        { id: "reported-beat", proofTimes: [3.45] },
        { id: "same-window-other-beat", proofTimes: [3.6] },
        { id: "outside-beat", proofTimes: [1] },
      ],
    } as SequenceArtifactV1;
    const cluster = {
      beatIds: ["reported-beat"],
      timeRange: [3.435, 5],
    } as LayoutClusterV1;

    expect(layoutRepairProofScope(sequence, cluster).unchangedProofs).toEqual([
      { beatId: "outside-beat", time: 1 },
    ]);
  });

  it("treats every beat in one persistent repaired composition as in scope", () => {
    const sequence = {
      beats: [
        {
          id: "feedback-flood",
          proofTimes: [2.6],
          implementationFiles: ["compositions/product-world.html"],
        },
        {
          id: "roadmap-state",
          proofTimes: [13.4],
          implementationFiles: ["compositions/product-world.html"],
        },
        {
          id: "separate-cta",
          proofTimes: [18.4],
          implementationFiles: ["compositions/cta.html"],
        },
      ],
    } as SequenceArtifactV1;
    const cluster = {
      beatIds: ["feedback-flood"],
      sourceFiles: ["compositions/product-world.html"],
      timeRange: [2.2, 3.5],
    } as LayoutClusterV1;

    expect(layoutRepairProofScope(sequence, cluster)).toEqual({
      targetBeatIds: ["feedback-flood", "roadmap-state"],
      targetEntityIds: [],
      unchangedProofs: [{ beatId: "separate-cta", time: 18.4 }],
    });
  });

  it("normalizes the website player runtime into authored compositions", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-player-runtime-"));
    roots.push(root);
    await mkdir(join(root, "assets", "vendor"), { recursive: true });
    await writeFile(
      join(root, "assets", "vendor", "hyperframe.runtime.iife.js"),
      "// runtime",
      "utf8",
    );
    await writeFile(
      join(root, "index.html"),
      "<html><body><script>window.__timelines = {};</script></body></html>",
      "utf8",
    );

    await ensurePlayerRuntime(root);

    expect(await readFile(join(root, "index.html"), "utf8")).toContain(
      "./assets/vendor/hyperframe.runtime.iife.js",
    );
  });

  it("adopts a contrast repair only after strict QA improves", async () => {
    const workspace = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-qa-loop-"));
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
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        await authorFreshBuildFixture(request.candidateRoot);
        await appendFile(request.candidateRoot + "/index.html", "\n<!-- authored -->\n", "utf8");
        return {
          final: {
            version: "sequences.codex-final.v1",
            intent: "Exercise category remediation.",
            artifacts: ["index.html", ...FRESH_BUILD_ARTIFACTS],
            skillsUsed: ["hyperframes", "hyperframes-core", "sequences-saas-launch"],
            limitations: [],
            proofTimes: [0],
          },
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          cliVersion: "codex-cli 0.0.0-test",
          sanitizedArguments: ["<fixture-author>"],
          stderr: "",
          threadId: "20000000-0000-4000-8000-000000000001",
          resumed: false,
        };
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    let attempts = 0;
    const verifier = {
      verify: async () => (++attempts === 1 ? failingContrastQa() : passingQa()),
      cancel: () => false,
    } as unknown as HyperframesVerifier;
    const manager = new JobManager(config, projects, runs, skills, codex, verifier);
    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Build and repair contrast.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const ready = await waitForApplied(manager, started.receipt.jobId);

    expect(attempts).toBe(2);
    expect(ready.receipt.qa?.ok).toBe(true);
    expect(ready.receipt.qaRemediations).toHaveLength(1);
    expect(ready.receipt.qaRemediations[0]?.repaired[0]).toMatchObject({
      sourceFile: "index.html",
      strategy: "foreground",
      requiredRatio: 4.5,
    });
    const candidate = await readFile(
      join(projects.candidateRoot(started.receipt.jobId), "index.html"),
      "utf8",
    );
    expect(candidate).toContain('data-sequences-qa-fixer="contrast-v1"');
    await expect(
      readFile(join(projects.candidateRoot(started.receipt.jobId), "index.motion.json"), "utf8"),
    ).resolves.toContain("appearsBy");
  }, 30_000);

  it("keeps a lower contrast deficit so multi-background repair can converge", async () => {
    const workspace = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-qa-contrast-union-"));
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
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        await authorFreshBuildFixture(request.candidateRoot);
        await appendFile(request.candidateRoot + "/index.html", "\n<!-- authored -->\n", "utf8");
        return codexResult({
          threadId: "20000000-0000-4000-8000-000000000011",
          resumed: false,
          intent: "Exercise multi-background contrast convergence.",
          artifacts: ["index.html", ...FRESH_BUILD_ARTIFACTS],
        });
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    let attempts = 0;
    const verifier = {
      verify: async () => {
        attempts += 1;
        if (attempts === 1) return failingContrastQa();
        if (attempts === 2) return failingContrastQaOnAlternativeBackground();
        return passingQa();
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
      prompt: "Build and converge contrast across two product states.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const ready = await waitForApplied(manager, started.receipt.jobId);

    expect(attempts).toBe(3);
    expect(ready.receipt.qaRemediations.map(({ category }) => category)).toEqual([
      "contrast",
      "contrast",
    ]);
    expect(ready.receipt.qa?.ok).toBe(true);
  }, 30_000);

  it("remediates a boundary tween overlap deterministically and adopts on improvement", async () => {
    const workspace = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-tween-loop-"));
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
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        await authorFreshBuildFixture(request.candidateRoot);
        await appendFile(
          request.candidateRoot + "/index.html",
          '\n<script>tl.to("#chip", { x: -8, y: 4, duration: 0.16 }, 10.46);\ntl.to("#chip", { x: 0, y: 0, duration: 0.18 }, 10.62);</script>\n',
          "utf8",
        );
        return {
          final: {
            version: "sequences.codex-final.v1",
            intent: "Exercise tween-overlap remediation.",
            artifacts: ["index.html", ...FRESH_BUILD_ARTIFACTS],
            skillsUsed: ["hyperframes", "hyperframes-core", "sequences-saas-launch"],
            limitations: [],
            proofTimes: [0],
          },
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          cliVersion: "codex-cli 0.0.0-test",
          sanitizedArguments: ["<fixture-author>"],
          stderr: "",
          threadId: "20000000-0000-4000-8000-000000000003",
          resumed: false,
        };
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    let attempts = 0;
    const verifier = {
      verify: async () => (++attempts === 1 ? failingTweenOverlapQa() : passingQa()),
      cancel: () => false,
    } as unknown as HyperframesVerifier;
    const manager = new JobManager(config, projects, runs, skills, codex, verifier);
    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Build and remediate the tween overlap.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const ready = await waitForApplied(manager, started.receipt.jobId);

    expect(attempts).toBe(2);
    expect(ready.receipt.state).toBe("applied");
    expect(ready.receipt.qaRemediations).toHaveLength(1);
    expect(ready.receipt.qaRemediations[0]).toMatchObject({
      category: "tween_overlap",
      repaired: [{ sourceFile: "index.html", selector: "#chip", property: "x, y", at: 10.62 }],
    });
    const candidate = await readFile(
      join(projects.candidateRoot(started.receipt.jobId), "index.html"),
      "utf8",
    );
    expect(candidate).toContain('{ overwrite: "auto", x: 0, y: 0, duration: 0.18 }, 10.62');
  }, 30_000);

  it("gives residual warning-only failures one bounded same-thread polish turn", async () => {
    const workspace = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-polish-turn-"));
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
    const directorThread = "20000000-0000-4000-8000-000000000004";
    const turns: Array<{
      operation: CodexRunRequest["operation"];
      prompt: string;
      evidenceImagePaths: readonly string[] | undefined;
    }> = [];
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push({
          operation: request.operation,
          prompt: request.prompt,
          evidenceImagePaths: request.evidenceImagePaths,
        });
        if (request.operation === "qa_repair") {
          await appendFile(
            request.candidateRoot + "/index.html",
            "\n<!-- polish: atomic swap replaces crossfade -->\n",
            "utf8",
          );
          return {
            final: null,
            exitCode: 0,
            timedOut: false,
            cancelled: false,
            cliVersion: "codex-cli 0.0.0-test",
            sanitizedArguments: ["resume", "<director-thread>"],
            stderr: "",
            threadId: directorThread,
            resumed: true,
            diskComplete: true,
          };
        }
        await authorFreshBuildFixture(request.candidateRoot);
        await appendFile(request.candidateRoot + "/index.html", "\n<!-- authored -->\n", "utf8");
        return {
          final: {
            version: "sequences.codex-final.v1",
            intent: "Exercise the polish turn.",
            artifacts: ["index.html", ...FRESH_BUILD_ARTIFACTS],
            skillsUsed: ["hyperframes", "hyperframes-core", "sequences-saas-launch"],
            limitations: [],
            proofTimes: [0],
          },
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          cliVersion: "codex-cli 0.0.0-test",
          sanitizedArguments: ["<fixture-author>"],
          stderr: "",
          threadId: directorThread,
          resumed: false,
        };
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    let attempts = 0;
    const verifier = {
      verify: async (_jobId: string, _candidateRoot: string, runRoot: string) => {
        attempts += 1;
        if (attempts === 1) {
          const snapshotRoot = join(runRoot, "qa", "attempt-1", "snapshots");
          await mkdir(snapshotRoot, { recursive: true });
          await writeFile(join(snapshotRoot, "finding-00-contrast_aa_failure.png"), "png");
          return warningOnlyQa();
        }
        return passingQa();
      },
      cancel: () => false,
    } as unknown as HyperframesVerifier;
    const manager = new JobManager(config, projects, runs, skills, codex, verifier);
    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Build and polish the residual warning.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const ready = await waitForApplied(manager, started.receipt.jobId);

    expect(attempts).toBe(2);
    expect(ready.receipt.state).toBe("applied");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.operation).toBe("qa_repair");
    expect(turns[1]?.prompt).toContain("Focused residual HyperFrames QA repair");
    expect(turns[1]?.prompt).toContain("crossfade");
    expect(turns[1]?.evidenceImagePaths).toEqual([
      join(
        config.runsRoot,
        started.receipt.jobId,
        "qa",
        "attempt-1",
        "snapshots",
        "finding-00-contrast_aa_failure.png",
      ),
    ]);
    expect(ready.receipt.qaRemediations).toHaveLength(1);
    expect(ready.receipt.qaRemediations[0]).toMatchObject({
      category: "author_polish",
      threadId: directorThread,
      evidenceImages: ["qa/attempt-1/snapshots/finding-00-contrast_aa_failure.png"],
      repaired: [{ sourceFile: "index.html" }],
    });
  }, 30_000);

  it("repairs hard non-layout QA failures in two improving same-thread turns with original images", async () => {
    const workspace = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-hard-qa-repair-"));
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
      imageInputsRoot: join(tempRoot, "image-inputs"),
      skillsRoot: join(workspace, ".agents", "skills"),
      skillsManifestPath: join(workspace, ".agents", "skills-manifest.json"),
      registryManifestPath: join(workspace, ".agents", "registry", "registry.json"),
    });
    const projects = new ProjectStore(config);
    await projects.initialize();
    const reference = await projects.storeImageInput(png(320, 180), "image/png");
    const runs = new RunStore(projects);
    const skills = new SkillBundle(config);
    const directorThread = "20000000-0000-4000-8000-000000000005";
    const originalPrompt = "Launch the reference product without changing its visual identity.";
    const turns: Array<{
      operation: CodexRunRequest["operation"];
      threadId: string | null;
      imagePaths: readonly string[];
      prompt: string;
      qaCodes: string[];
    }> = [];
    let repairTurns = 0;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push({
          operation: request.operation,
          threadId: request.threadId,
          imagePaths: request.imagePaths,
          prompt: request.prompt,
          qaCodes: request.authorContext.qaFindings.flatMap((finding) =>
            typeof finding === "object" && finding !== null && "code" in finding
              ? [String(finding.code)]
              : [],
          ),
        });
        if (request.operation === "contract_repair") {
          if (request.artifactDirectory) {
            await mkdir(join(request.runRoot, request.artifactDirectory), { recursive: true });
          }
          await recreateFixtureReferences(request.candidateRoot, [reference.path]);
          return codexResult({
            threadId: directorThread,
            resumed: true,
            intent: "Repair the reference-only image contract on the owning thread.",
            artifacts: ["compositions/02-compose.html"],
          });
        }
        if (request.operation === "qa_repair") {
          repairTurns += 1;
          await appendFile(
            join(request.candidateRoot, "compositions", "02-compose.html"),
            `\n<!-- hard QA repair ${repairTurns} -->\n`,
            "utf8",
          );
          return codexResult({
            threadId: directorThread,
            resumed: true,
            intent: `Repair residual hard QA pass ${repairTurns}.`,
            artifacts: ["compositions/02-compose.html"],
          });
        }
        await authorFreshBuildFixture(request.candidateRoot);
        await appendMissingMotionAssertion(request.candidateRoot, "#removed-motion-target");
        await bindFixtureToReferences(request.candidateRoot, [reference.path]);
        await appendFile(request.candidateRoot + "/index.html", "\n<!-- authored -->\n", "utf8");
        return codexResult({
          threadId: directorThread,
          resumed: false,
          intent: "Exercise hard non-layout QA recovery.",
          artifacts: ["index.html", ...FRESH_BUILD_ARTIFACTS],
        });
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    let attempts = 0;
    const verifier = {
      verify: async () => {
        attempts += 1;
        if (attempts === 1) {
          return hardNonLayoutQa(["gsap_non_transform_motion"]);
        }
        if (attempts === 2) {
          return hardNonLayoutQa(["motion_appears_late", "motion_frozen"]);
        }
        return passingQa();
      },
      cancel: () => false,
    } as unknown as HyperframesVerifier;
    const manager = new JobManager(config, projects, runs, skills, codex, verifier);
    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: originalPrompt,
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
      imagePaths: [reference.path],
    });
    const ready = await waitForApplied(manager, started.receipt.jobId);

    expect(attempts).toBe(3);
    expect(repairTurns).toBe(2);
    expect(turns.map((turn) => turn.operation)).toEqual([
      undefined,
      "contract_repair",
      "qa_repair",
      "qa_repair",
    ]);
    for (const turn of turns.slice(1)) {
      expect(turn.threadId).toBe(directorThread);
      expect(turn.imagePaths).toEqual([reference.path]);
      expect(turn.prompt).toContain(reference.path);
    }
    for (const turn of turns.filter((turn) => turn.operation === "qa_repair")) {
      expect(turn.prompt).toContain(JSON.stringify(originalPrompt));
    }
    expect(turns[1]?.qaCodes).toEqual([]);
    expect(turns[2]?.qaCodes).toEqual(["gsap_non_transform_motion"]);
    expect(turns[3]?.qaCodes).toEqual([
      "motion_appears_late",
      "motion_frozen",
      "gsap_non_transform_motion",
    ]);
    expect(turns[3]?.prompt).toContain("repair the authored entrance");
    expect(turns[3]?.prompt).toContain("the host will not rewrite timing for you");
    expect(ready.receipt.state).toBe("applied");
    expect(ready.receipt.qa?.ok).toBe(true);
    expect(ready.receipt.qa?.findings).toContainEqual(
      expect.objectContaining({
        code: "motion_selector_missing",
        severity: "info",
        selector: "#removed-motion-target",
      }),
    );
    expect(ready.receipt.qaRemediations).toMatchObject([
      { category: "author_polish", pass: 1, threadId: directorThread },
    ]);
  }, 30_000);

  it("restores hard QA repairs that reduce findings by introducing layout debt", async () => {
    const workspace = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-hard-qa-rollback-"));
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
    const directorThread = "20000000-0000-4000-8000-000000000006";
    let repairTurns = 0;
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        if (request.operation === "qa_repair") {
          repairTurns += 1;
          await appendFile(
            join(request.candidateRoot, "compositions", "02-compose.html"),
            `\n<!-- rejected layout regression ${repairTurns} -->\n`,
            "utf8",
          );
          return codexResult({
            threadId: directorThread,
            resumed: true,
            intent: "A repair that must be rolled back.",
            artifacts: ["compositions/02-compose.html"],
          });
        }
        await authorFreshBuildFixture(request.candidateRoot);
        await appendFile(request.candidateRoot + "/index.html", "\n<!-- authored -->\n", "utf8");
        return codexResult({
          threadId: directorThread,
          resumed: false,
          intent: "Exercise transactional hard-QA rollback.",
          artifacts: ["index.html", ...FRESH_BUILD_ARTIFACTS],
        });
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    let attempts = 0;
    const verifier = {
      verify: async () => {
        attempts += 1;
        return attempts === 1
          ? hardNonLayoutQa(["motion_selector_missing", "motion_off_frame"])
          : failingLayoutQa(`qa/attempt-${attempts}`);
      },
      cancel: () => false,
    } as unknown as HyperframesVerifier;
    const manager = new JobManager(config, projects, runs, skills, codex, verifier);
    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Do not trade motion correctness for broken layout.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const terminal = await waitForTerminal(manager, started.receipt.jobId);

    expect(terminal.receipt.state).toBe("failed");
    expect(attempts).toBe(3);
    expect(repairTurns).toBe(2);
    expect(terminal.receipt.qaRemediations).toEqual([]);
    const candidate = await readFile(
      join(projects.candidateRoot(started.receipt.jobId), "compositions", "02-compose.html"),
      "utf8",
    );
    expect(candidate).not.toContain("rejected layout regression");
  }, 30_000);

  it("repairs one clustered handoff in the same candidate and director thread", async () => {
    const workspace = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "sequences-layout-repair-"));
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
    const directorThread = "20000000-0000-4000-8000-000000000002";
    const turns: Array<{
      operation: CodexRunRequest["operation"];
      candidateRoot: string;
      threadId: string | null;
      evidence: readonly string[];
      qaCodes: string[];
      allowedPaths: readonly string[];
      prompt: string;
    }> = [];
    const codex = {
      async run(request: CodexRunRequest): Promise<CodexRunResult> {
        turns.push({
          operation: request.operation,
          candidateRoot: request.candidateRoot,
          threadId: request.threadId,
          evidence: request.evidenceImagePaths ?? [],
          qaCodes: request.authorContext.qaFindings.flatMap((finding) =>
            typeof finding === "object" && finding !== null && "code" in finding
              ? [String(finding.code)]
              : [],
          ),
          allowedPaths: request.allowedPaths,
          prompt: request.prompt,
        });
        if (request.operation === "layout_repair") {
          await appendFile(
            join(request.candidateRoot, "compositions", "02-compose.html"),
            "\n<!-- focused handoff timing repair -->\n",
            "utf8",
          );
          return {
            final: null,
            exitCode: 0,
            timedOut: false,
            cancelled: false,
            cliVersion: "codex-cli 0.0.0-test",
            sanitizedArguments: ["resume", "<director-thread>"],
            stderr: "",
            threadId: directorThread,
            resumed: true,
            diskComplete: true,
          };
        }
        await authorFreshBuildFixture(request.candidateRoot);
        await appendFile(request.candidateRoot + "/index.html", "\n<!-- authored -->\n", "utf8");
        // A real author always replaces the placeholder sequence. The repair
        // cluster targets compositions/02-compose.html, so the intro beat that
        // only touches index.html must stay proof-compared during repair.
        await writeFile(
          join(request.candidateRoot, "sequence.json"),
          `${JSON.stringify({
            version: "sequences.sequence.v1",
            format: { width: 1920, height: 1080, fps: 30, targetDuration: 5 },
            concept: {
              summary: "Layout-repair fixture story",
              hierarchy: ["intro", "compose-workspace"],
              motionGrammar: ["deterministic"],
              rejectedChoices: [],
            },
            beats: [
              {
                id: "intro",
                role: "hook",
                start: 0,
                duration: 2,
                purpose: "Fixture intro beat",
                claims: [],
                entities: [
                  {
                    id: "workflow-panel",
                    role: "Persistent product workflow panel",
                    parts: ["workflow-status"],
                  },
                ],
                sourceIds: [],
                musicAnchors: [],
                proofTimes: [1],
                implementationFiles: ["index.html"],
              },
              {
                id: "compose-workspace",
                role: "product-proof",
                start: 2,
                duration: 3,
                purpose: "Fixture compose beat",
                claims: [],
                entities: [
                  {
                    id: "workflow-panel",
                    role: "Persistent product workflow panel",
                    parts: ["workflow-status"],
                  },
                ],
                sourceIds: [],
                musicAnchors: [],
                proofTimes: [3],
                implementationFiles: ["compositions/02-compose.html"],
              },
            ],
            transitions: [
              {
                id: "intro-to-compose",
                fromBeatId: "intro",
                toBeatId: "compose-workspace",
                kind: "cut",
                at: 2,
                duration: 0,
                rationale: "Fixture boundary",
              },
            ],
            overlapIntents: [],
            revision: null,
          })}\n`,
          "utf8",
        );
        const componentPlanPath = join(request.candidateRoot, "story", "component-plan.json");
        const componentPlan = JSON.parse(await readFile(componentPlanPath, "utf8")) as {
          components: Array<{ usedInBeatIds: string[]; implementationFiles: string[] }>;
        };
        for (const component of componentPlan.components) {
          component.usedInBeatIds = ["intro", "compose-workspace"];
          component.implementationFiles = ["index.html", "compositions/02-compose.html"];
        }
        await writeFile(componentPlanPath, `${JSON.stringify(componentPlan, null, 2)}\n`, "utf8");
        return {
          final: {
            version: "sequences.codex-final.v1",
            intent: "Exercise focused layout repair.",
            artifacts: ["index.html", ...FRESH_BUILD_ARTIFACTS],
            skillsUsed: ["hyperframes", "hyperframes-core", "sequences-saas-launch"],
            limitations: [],
            proofTimes: [0],
          },
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          cliVersion: "codex-cli 0.0.0-test",
          sanitizedArguments: ["<fixture-author>"],
          stderr: "",
          threadId: directorThread,
          resumed: false,
        };
      },
      cancel: () => false,
    } as unknown as CodexRunner;
    let qaAttempts = 0;
    const layoutQaWithMotion = (
      prefix: string,
      motionCodes: Array<"motion_appears_late" | "motion_frozen">,
    ): QaReceiptV1 => {
      const layoutQa = failingLayoutQa(prefix);
      const motionFindings = hardNonLayoutQa(motionCodes).findings;
      return {
        ...layoutQa,
        summary: {
          ...layoutQa.summary,
          errorCount: layoutQa.summary.errorCount + motionFindings.length,
        },
        findings: [...layoutQa.findings, ...motionFindings],
      };
    };
    const verifier = {
      verify: async (
        _jobId: string,
        _candidateRoot: string,
        runRoot: string,
        options: { artifactDirectory?: string },
      ) => {
        qaAttempts += 1;
        if (qaAttempts === 1) {
          await writeLayoutEvidence(runRoot, options.artifactDirectory ?? "qa/attempt-1");
          return layoutQaWithMotion(options.artifactDirectory ?? "qa/attempt-1", [
            "motion_appears_late",
          ]);
        }
        if (qaAttempts === 2) {
          await writeLayoutEvidence(runRoot, options.artifactDirectory ?? "qa/attempt-2");
          return layoutQaWithMotion(options.artifactDirectory ?? "qa/attempt-2", [
            "motion_appears_late",
            "motion_frozen",
          ]);
        }
        if (qaAttempts === 3) {
          await writeLayoutEvidence(runRoot, options.artifactDirectory ?? "qa/attempt-3");
          return failingLayoutQa(options.artifactDirectory ?? "qa/attempt-3");
        }
        if (qaAttempts === 4) return failingContrastQa();
        return passingQa();
      },
      cancel: () => false,
    } as unknown as HyperframesVerifier;
    let proofCalls = 0;
    const proofs = {
      compare: async () => {
        proofCalls += 1;
        return {
          version: "sequences.proof-comparison.v1" as const,
          ok: true,
          artifact: "layout-repair/attempt-1/proof/receipt.json",
          frames: [
            {
              beatId: "evidence-intake",
              time: 2,
              baseSha256: "0".repeat(64),
              candidateSha256: "0".repeat(64),
              identical: true,
            },
          ],
        };
      },
    } as unknown as ProofComparator;
    const manager = new JobManager(config, projects, runs, skills, codex, verifier, proofs);
    const started = await manager.start("release-a", {
      version: "sequences.start-job.v1",
      kind: "build",
      prompt: "Build and repair the handoff.",
      baseCommit: await projects.acceptedCommit(),
      directorMode: "reset",
    });
    const ready = await waitForApplied(manager, started.receipt.jobId);

    expect(qaAttempts).toBe(5);
    expect(proofCalls).toBe(3);
    expect(turns).toHaveLength(4);
    expect(turns[1]).toMatchObject({
      operation: "layout_repair",
      candidateRoot: turns[0]?.candidateRoot,
      threadId: directorThread,
    });
    expect(turns[1]?.evidence).toHaveLength(2);
    expect(turns[1]?.qaCodes).toEqual(["text_box_overflow", "motion_appears_late"]);
    expect(turns[2]?.qaCodes).toEqual([
      "text_box_overflow",
      "motion_appears_late",
      "motion_frozen",
    ]);
    expect(turns[1]?.allowedPaths).toContain("index.motion.json");
    expect(turns[2]?.allowedPaths).toContain("index.motion.json");
    expect(turns[3]?.qaCodes).toEqual(["text_box_overflow"]);
    expect(turns[3]?.allowedPaths).not.toContain("index.motion.json");
    expect(turns[1]?.prompt).toContain("The host will not rewrite authored timing for you");
    expect(ready.receipt.qa?.ok).toBe(true);
    expect(ready.receipt.qaRemediations).toHaveLength(1);
    expect(ready.receipt.qaRemediations[0]).toMatchObject({
      category: "contrast",
      inputArtifact: "qa/attempt-4/qa.json",
      outputArtifact: "qa/attempt-5/qa.json",
    });
    expect(ready.receipt.layoutRepairs).toMatchObject([
      {
        attempt: 1,
        threadId: directorThread,
        resumed: true,
        adopted: false,
        beforeUnresolvedClusters: 1,
        afterUnresolvedClusters: 1,
        inputQaArtifact: "qa/attempt-1/qa.json",
        outputQaArtifact: "qa/attempt-2/qa.json",
      },
      {
        attempt: 2,
        threadId: directorThread,
        resumed: true,
        adopted: true,
        beforeUnresolvedClusters: 1,
        afterUnresolvedClusters: 1,
        inputQaArtifact: "qa/attempt-1/qa.json",
        outputQaArtifact: "qa/attempt-3/qa.json",
      },
      {
        attempt: 3,
        threadId: directorThread,
        resumed: true,
        adopted: true,
        beforeUnresolvedClusters: 1,
        afterUnresolvedClusters: 0,
        inputQaArtifact: "qa/attempt-3/qa.json",
        outputQaArtifact: "qa/attempt-4/qa.json",
      },
    ]);
  }, 30_000);
});

function failingContrastQa(): QaReceiptV1 {
  return {
    version: "sequences.qa-receipt.v1",
    hyperframesVersion: "0.7.56",
    ok: false,
    commands: [
      { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
      { command: "check", ok: false, exitCode: 1, durationMs: 1, artifact: "check.json" },
    ],
    summary: { errorCount: 1, warningCount: 0, infoCount: 0 },
    findings: [
      {
        command: "check",
        category: "contrast",
        code: "contrast_aa_failure",
        severity: "error",
        sourceFile: "index.html",
        selector: "#root",
        times: [0.08, 15],
        message: "Contrast is 3.33:1; WCAG AA requires 4.5:1.",
        fixHint: null,
        contrast: {
          samples: [
            {
              foreground: "rgb(49,87,246)",
              background: "rgb(240,195,108)",
              ratio: 3.33,
              requiredRatio: 4.5,
              suggestedColor: "rgb(40,71,200)",
            },
          ],
        },
        artifact: "check.json",
      },
    ],
  };
}

function failingContrastQaOnAlternativeBackground(): QaReceiptV1 {
  const qa = failingContrastQa();
  const finding = qa.findings[0]!;
  finding.message = "Contrast is 4.25:1; WCAG AA requires 4.5:1.";
  finding.contrast!.samples = [
    {
      foreground: "rgb(122,138,160)",
      background: "rgb(22,39,67)",
      ratio: 4.25,
      requiredRatio: 4.5,
      suggestedColor: "rgb(127,143,164)",
    },
  ];
  return qa;
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

function hardNonLayoutQa(
  codes: Array<
    | "motion_selector_missing"
    | "motion_appears_late"
    | "motion_frozen"
    | "motion_off_frame"
    | "gsap_non_transform_motion"
  >,
): QaReceiptV1 {
  const hasLintFailure = codes.includes("gsap_non_transform_motion");
  return {
    version: "sequences.qa-receipt.v1",
    hyperframesVersion: "0.7.56",
    ok: false,
    commands: [
      {
        command: "lint",
        ok: !hasLintFailure,
        exitCode: hasLintFailure ? 1 : 0,
        durationMs: 1,
        artifact: "lint.json",
      },
      { command: "check", ok: false, exitCode: 1, durationMs: 1, artifact: "check.json" },
    ],
    summary: { errorCount: codes.length, warningCount: 0, infoCount: 0 },
    findings: codes.map((code) => {
      const lint = code === "gsap_non_transform_motion";
      const selector = code === "motion_selector_missing" ? "#missing-panel" : "#shell-window";
      return {
        command: lint ? ("lint" as const) : ("check" as const),
        category: lint ? "lint" : "motion",
        code,
        severity: "error" as const,
        sourceFile:
          lint || code !== "motion_selector_missing"
            ? "compositions/02-compose.html"
            : "index.motion.json",
        selector,
        times: [1.25],
        message:
          code === "motion_selector_missing"
            ? `Motion selector ${selector} did not match the assembled DOM.`
            : code === "motion_appears_late"
              ? `${selector} was not measurably visible by its asserted entrance time.`
              : code === "motion_frozen"
                ? `${selector} remained static through the asserted interval.`
                : code === "motion_off_frame"
                  ? `${selector} left the output frame during its animated pose.`
                  : `${selector} animates a layout property instead of a transform.`,
        fixHint: "Correct the authored DOM, motion, or assertion without suppressing QA.",
        artifact: lint ? "lint.json" : "check.json",
      };
    }),
  };
}

async function appendMissingMotionAssertion(root: string, selector: string): Promise<void> {
  const path = join(root, "index.motion.json");
  const motion = JSON.parse(await readFile(path, "utf8")) as {
    assertions: Array<Record<string, unknown>>;
  };
  motion.assertions.push({ kind: "appearsBy", selector, bySec: 4 });
  await writeFile(path, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
}

function failingTweenOverlapQa(): QaReceiptV1 {
  return {
    version: "sequences.qa-receipt.v1",
    hyperframesVersion: "0.7.56",
    ok: false,
    commands: [
      { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
      { command: "check", ok: false, exitCode: 1, durationMs: 1, artifact: "check.json" },
    ],
    summary: { errorCount: 0, warningCount: 1, infoCount: 0 },
    findings: [
      {
        command: "lint",
        category: "lint",
        code: "overlapping_gsap_tweens",
        severity: "warning",
        sourceFile: "index.html",
        selector: "#chip",
        times: [0],
        message: 'GSAP tweens overlap on "#chip" for x, y between 10.62s and 10.62s.',
        fixHint: 'Shorten the earlier tween, move the later tween, or add `overwrite: "auto"`.',
        artifact: "lint.json",
      },
    ],
  };
}

function warningOnlyQa(): QaReceiptV1 {
  return {
    version: "sequences.qa-receipt.v1",
    hyperframesVersion: "0.7.56",
    ok: false,
    commands: [
      { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
      { command: "check", ok: false, exitCode: 1, durationMs: 1, artifact: "check.json" },
    ],
    summary: { errorCount: 0, warningCount: 1, infoCount: 0 },
    findings: [
      {
        command: "check",
        category: "contrast",
        code: "contrast_aa_failure",
        severity: "warning",
        sourceFile: "index.html",
        selector: "#status-chip",
        times: [15.08],
        message: "Contrast is 1.62:1 while the chip crossfade is mid-transition.",
        fixHint: "Use an atomic visibility swap so text never composites semi-transparent.",
        artifact: "check.json",
      },
    ],
  };
}

function failingLayoutQa(prefix: string): QaReceiptV1 {
  return {
    version: "sequences.qa-receipt.v1",
    hyperframesVersion: "0.7.56",
    ok: false,
    commands: [
      { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: `${prefix}/lint.json` },
      {
        command: "check",
        ok: false,
        exitCode: 1,
        durationMs: 1,
        artifact: `${prefix}/check.json`,
      },
    ],
    summary: { errorCount: 1, warningCount: 0, infoCount: 0 },
    findings: [
      {
        command: "check",
        category: "layout",
        code: "text_box_overflow",
        severity: "error",
        sourceFile: "compositions/02-compose.html",
        selector: ".compose-card",
        times: [10.815],
        message: "Text extends outside its nearest visual/container box.",
        fixHint: "Move the text box inside the 1920 by 1080 frame.",
        artifact: `${prefix}/check.json`,
      },
    ],
    layoutClusters: [
      {
        id: "layout-cluster-test-handoff",
        kind: "handoff",
        status: "undeclared",
        sampleTime: 10.815,
        timeRange: [10.815, 10.833],
        findingCount: 20,
        observationCount: 25,
        beatIds: ["compose-workspace", "verified-receipt"],
        compositionIds: ["compose-workspace", "verified-receipt"],
        sourceFiles: ["compositions/02-compose.html", "compositions/03-receipt.html"],
        entityIds: ["compose-morph-card", "candidate-receipt"],
        intentId: null,
        summary:
          "compose-workspace → verified-receipt handoff caused one unresolved layout cluster at 10.815s, affecting 20 descendants.",
        artifacts: {
          inspection: `${prefix}/layout/clusters/layout-cluster-test-handoff/inspection.json`,
          fullFrame: `${prefix}/layout/clusters/layout-cluster-test-handoff/full-frame.png`,
          crop: `${prefix}/layout/clusters/layout-cluster-test-handoff/crop.png`,
        },
      },
    ],
  };
}

async function writeLayoutEvidence(runRoot: string, prefix: string): Promise<void> {
  const root = join(runRoot, prefix, "layout", "clusters", "layout-cluster-test-handoff");
  await mkdir(root, { recursive: true });
  const rect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
  await writeFile(
    join(root, "inspection.json"),
    `${JSON.stringify(
      {
        clusterId: "layout-cluster-test-handoff",
        sampleTime: 10.815,
        canvas: rect,
        safeArea: rect,
        grid: { columns: 12, rows: 8, columnGap: 8, rowGap: 8, margin: 0 },
        entities: [
          {
            identity: {
              beatId: "compose-workspace",
              compositionId: "compose-workspace",
              entityId: "compose-morph-card",
              hfId: "compose-card",
              selector: ".compose-card",
            },
            bbox: rect,
            opacity: 1,
            zIndex: 1,
            stackingContexts: [],
            parentContentBox: rect,
            lineBoxes: [rect],
            readabilityOwner: "compose-morph-card",
            readable: false,
          },
          {
            identity: {
              beatId: "verified-receipt",
              compositionId: "verified-receipt",
              entityId: "candidate-receipt",
              hfId: "receipt-card",
              selector: ".receipt-card",
            },
            bbox: rect,
            opacity: 1,
            zIndex: 2,
            stackingContexts: [],
            parentContentBox: rect,
            lineBoxes: [rect],
            readabilityOwner: "candidate-receipt",
            readable: false,
          },
        ],
        intersections: [
          {
            entityIds: ["compose-morph-card", "candidate-receipt"],
            bbox: rect,
            area: 10_000,
            percent: 100,
          },
        ],
        guides: [],
        availableRegions: [],
        suggestedPositions: [],
        policyViolations: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(root, "full-frame.png"), "frame", "utf8");
  await writeFile(join(root, "crop.png"), "crop", "utf8");
}

async function waitForApplied(manager: JobManager, jobId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await manager.get(jobId);
    if (response.receipt.state === "applied") return response;
    if (["failed", "cancelled", "timed_out"].includes(response.receipt.state)) {
      throw new Error(response.receipt.error?.message ?? `Job ended in ${response.receipt.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for applied");
}

async function waitForTerminal(manager: JobManager, jobId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await manager.get(jobId);
    if (["applied", "failed", "cancelled", "timed_out"].includes(response.receipt.state)) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for terminal job state");
}

function codexResult(options: {
  threadId: string;
  resumed: boolean;
  intent: string;
  artifacts: readonly string[];
}): CodexRunResult {
  return {
    final: {
      version: "sequences.codex-final.v1",
      intent: options.intent,
      artifacts: [...options.artifacts],
      skillsUsed: ["hyperframes", "hyperframes-core", "sequences-saas-launch"],
      limitations: [],
      proofTimes: [1.25],
    },
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    cliVersion: "codex-cli 0.0.0-test",
    sanitizedArguments: options.resumed ? ["resume", "<director-thread>"] : ["<fixture-author>"],
    stderr: "",
    threadId: options.threadId,
    resumed: options.resumed,
  };
}

async function bindFixtureToReferences(root: string, imagePaths: readonly string[]): Promise<void> {
  const capsulePath = join(root, "story", "design-capsule.json");
  const capsule = JSON.parse(await readFile(capsulePath, "utf8")) as Record<string, unknown>;
  capsule.origin = {
    kind: "reference-derived",
    fidelity: "reference-locked",
    imagePaths: [...imagePaths],
    rationale: "The supplied product reference remains the visual source of truth.",
  };
  await writeFile(capsulePath, `${JSON.stringify(capsule, null, 2)}\n`, "utf8");

  const planPath = join(root, "story", "component-plan.json");
  const plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
  plan.mode = "reference-derived";
  plan.sourceImages = [...imagePaths];
  plan.sourceImageBindings = imagePaths.map((imagePath, index) => ({
    imagePath,
    beatIds: [index === 0 ? "product-action" : "product-proof"],
    narrativeRole: index === 0 ? "action" : "proof",
    purpose: "Use the supplied product state as causal story evidence.",
  }));
  plan.sourceEvidence = "The supplied product reference defines the retained visual vocabulary.";
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const compositionPath = join(root, "compositions", "02-compose.html");
  const composition = await readFile(compositionPath, "utf8");
  const references = imagePaths
    .map(
      (imagePath, index) =>
        `<img src="${imagePath}" data-reference-image="${imagePath}" data-reference-beats="${index === 0 ? "product-action" : "product-proof"}" alt="Product reference" />`,
    )
    .join("\n");
  await writeFile(
    compositionPath,
    composition.replace("</template>", `${references}\n</template>`),
    "utf8",
  );
}

async function recreateFixtureReferences(
  root: string,
  imagePaths: readonly string[],
): Promise<void> {
  const compositionPath = join(root, "compositions", "02-compose.html");
  let composition = await readFile(compositionPath, "utf8");
  for (const [index, imagePath] of imagePaths.entries()) {
    const beats = index === 0 ? "product-action" : "product-proof";
    composition = composition.replace(
      `<img src="${imagePath}" data-reference-image="${imagePath}" data-reference-beats="${beats}" alt="Product reference" />`,
      `<section data-reference-image="${imagePath}" data-reference-mode="recreated" data-reference-beats="${beats}">Code-native product recreation</section>`,
    );
  }
  await writeFile(compositionPath, composition, "utf8");
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}
