import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerConfig } from "../../src/server/config";
import { ApiProblem } from "../../src/server/errors";
import { ProjectStore } from "../../src/server/project-store";

const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function store() {
  const dataRoot = mkdtempSync(join(tmpdir(), "sequences-replay-"));
  roots.push(dataRoot);
  const workspace = process.cwd();
  const config = createServerConfig({
    workspaceRoot: workspace,
    acceptedRoot: join(dataRoot, "accepted"),
    seedRoot: join(workspace, "fixtures", "release-a"),
    candidatesRoot: join(dataRoot, "candidates"),
    runsRoot: join(dataRoot, "runs"),
    rendersRoot: join(dataRoot, "renders"),
    renderWorktreesRoot: join(dataRoot, "render-worktrees"),
  });
  const projects = new ProjectStore(config);
  await projects.initialize();
  return { projects, config };
}

describe("candidate promotion replay protection", () => {
  it("fast-forwards a verified candidate when accepted HEAD still matches", async () => {
    const { projects } = await store();
    const base = await projects.acceptedCommit();
    const jobId = `run_${"1".repeat(32)}`;
    const candidate = await projects.createCandidate(jobId, base);
    writeFileSync(join(candidate, "STORYBOARD.md"), "# Updated in isolated candidate\n", "utf8");
    const commit = await projects.createCandidateCommit(candidate, jobId);

    await expect(projects.applyCandidate(base, commit)).resolves.toBe(commit);
    await expect(projects.acceptedCommit()).resolves.toBe(commit);
  });

  it("refuses a stale candidate after accepted source advances", async () => {
    const { projects } = await store();
    const base = await projects.acceptedCommit();
    const jobId = `run_${"2".repeat(32)}`;
    const candidate = await projects.createCandidate(jobId, base);
    writeFileSync(join(candidate, "STORYBOARD.md"), "# Candidate branch\n", "utf8");
    const candidateCommit = await projects.createCandidateCommit(candidate, jobId);

    const acceptedJob = `run_${"3".repeat(32)}`;
    const acceptedCandidate = await projects.createCandidate(acceptedJob, base);
    writeFileSync(
      join(acceptedCandidate, "frame.md"),
      "# Accepted changed independently\n",
      "utf8",
    );
    const acceptedCommit = await projects.createCandidateCommit(acceptedCandidate, acceptedJob);
    await projects.applyCandidate(base, acceptedCommit);

    await expect(projects.applyCandidate(base, candidateCommit)).rejects.toSatisfy(
      (error: unknown) => error instanceof ApiProblem && error.code === "stale_base",
    );
  });
});
