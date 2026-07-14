import { cp, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { GitCommitSchema, JobIdSchema, PROJECT_ID, ProjectIdSchema } from "../shared";
import type { ServerConfig } from "./config";
import { ApiProblem } from "./errors";
import { isWithin, managedPath, posixPath } from "./files";
import { isolatedToolEnvironment, runProcess } from "./process-runner";

const GIT_TIMEOUT_MS = 60_000;

export class ProjectStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly config: ServerConfig) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.config.candidatesRoot, { recursive: true }),
      mkdir(this.config.runsRoot, { recursive: true }),
    ]);
    try {
      await stat(this.config.acceptedRoot);
    } catch {
      await this.seedAcceptedProject();
    }
    await this.assertNoSymlinks(this.config.acceptedRoot);
    await this.ensureGitRepository();
  }

  acceptedRoot(projectId: string): string {
    this.assertProject(projectId);
    return this.config.acceptedRoot;
  }

  runRoot(jobId: string): string {
    JobIdSchema.parse(jobId);
    return managedPath(this.config.runsRoot, jobId);
  }

  runsDirectory(): string {
    return this.config.runsRoot;
  }

  candidateRoot(jobId: string): string {
    JobIdSchema.parse(jobId);
    return managedPath(this.config.candidatesRoot, jobId);
  }

  async acceptedCommit(projectId = PROJECT_ID): Promise<string> {
    this.assertProject(projectId);
    return GitCommitSchema.parse((await this.git(this.config.acceptedRoot, ["rev-parse", "HEAD"])).trim());
  }

  async acceptedIsClean(): Promise<boolean> {
    return (await this.git(this.config.acceptedRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).trim() === "";
  }

  async createCandidate(jobId: string, baseCommit: string): Promise<string> {
    JobIdSchema.parse(jobId);
    GitCommitSchema.parse(baseCommit);
    const candidate = this.candidateRoot(jobId);
    try {
      await stat(candidate);
      throw new ApiProblem(409, "candidate_exists", "A candidate workspace already exists for this job");
    } catch (error) {
      if (error instanceof ApiProblem) throw error;
    }
    await mkdir(this.config.candidatesRoot, { recursive: true });
    await this.git(this.config.acceptedRoot, ["worktree", "add", "--detach", candidate, baseCommit]);
    await this.assertNoSymlinks(candidate, new Set([".git"]));
    return candidate;
  }

  async changedFiles(candidate: string, baseCommit: string): Promise<string[]> {
    this.assertCandidatePath(candidate);
    GitCommitSchema.parse(baseCommit);
    const [tracked, untracked] = await Promise.all([
      this.git(candidate, ["diff", "--name-only", "-z", baseCommit, "--"]),
      this.git(candidate, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    return [...new Set([...splitNull(tracked), ...splitNull(untracked)])].sort();
  }

  async createCandidateCommit(candidate: string, jobId: string): Promise<string> {
    this.assertCandidatePath(candidate);
    JobIdSchema.parse(jobId);
    await this.git(candidate, ["add", "--all", "--", "."]);
    await this.git(candidate, [
      "-c",
      "user.name=Sequences Host",
      "-c",
      "user.email=sequences@localhost.invalid",
      "commit",
      "--no-gpg-sign",
      "-m",
      `candidate: ${jobId}`,
    ]);
    return GitCommitSchema.parse((await this.git(candidate, ["rev-parse", "HEAD"])).trim());
  }

  async candidatePatch(candidate: string, baseCommit: string, candidateCommit: string): Promise<string> {
    this.assertCandidatePath(candidate);
    GitCommitSchema.parse(baseCommit);
    GitCommitSchema.parse(candidateCommit);
    return this.git(candidate, ["diff", "--binary", baseCommit, candidateCommit, "--"], 32 * 1_024 * 1_024);
  }

  async applyCandidate(baseCommit: string, candidateCommit: string): Promise<string> {
    return this.withMutationLock(async () => {
      const current = await this.acceptedCommit();
      if (current !== baseCommit || !(await this.acceptedIsClean())) {
        throw new ApiProblem(409, "stale_base", "Accepted source changed after this candidate was created");
      }
      await this.git(this.config.acceptedRoot, ["merge-base", "--is-ancestor", baseCommit, candidateCommit]);
      await this.git(this.config.acceptedRoot, ["merge", "--ff-only", "--no-edit", candidateCommit]);
      const accepted = await this.acceptedCommit();
      if (accepted !== candidateCommit) {
        throw new Error("Git promotion completed without advancing accepted HEAD to the candidate commit");
      }
      return accepted;
    });
  }

  async removeCandidate(jobId: string): Promise<void> {
    const candidate = this.candidateRoot(jobId);
    this.assertCandidatePath(candidate);
    await this.git(this.config.acceptedRoot, ["worktree", "remove", "--force", candidate]);
  }

  async listFiles(projectId = PROJECT_ID): Promise<string[]> {
    this.assertProject(projectId);
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if ([".git", ".agents", ".hyperframes", ".thumbnails", "node_modules", "renders", "snapshots"].includes(entry.name)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Symlinks are forbidden in accepted projects: ${absolute}`);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) files.push(posixPath(relative(this.config.acceptedRoot, absolute)));
        if (files.length > 5_000) throw new Error("Project file count exceeds the 5,000-file safety limit");
      }
    };
    await walk(this.config.acceptedRoot);
    return files.sort();
  }

  private async seedAcceptedProject(): Promise<void> {
    const seed = resolve(this.config.seedRoot);
    if (!isWithin(this.config.workspaceRoot, seed)) {
      throw new Error("The configured release-a seed is outside the workspace");
    }
    await this.assertNoSymlinks(seed);
    await mkdir(dirname(this.config.acceptedRoot), { recursive: true });
    await cp(seed, this.config.acceptedRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (source) => basename(source) !== ".git" && basename(source) !== "node_modules",
    });
  }

  private async ensureGitRepository(): Promise<void> {
    try {
      const inside = (await this.git(this.config.acceptedRoot, ["rev-parse", "--show-toplevel"])).trim();
      if (resolve(inside) !== resolve(this.config.acceptedRoot)) {
        throw new Error("Accepted release-a must be the root of its own Git repository");
      }
      await this.acceptedCommit();
      return;
    } catch (error) {
      if (error instanceof Error && error.message.includes("must be the root")) throw error;
    }
    await this.git(this.config.acceptedRoot, ["init", "--initial-branch=main"]);
    await this.git(this.config.acceptedRoot, ["add", "--all", "--", "."]);
    await this.git(this.config.acceptedRoot, [
      "-c",
      "user.name=Sequences Host",
      "-c",
      "user.email=sequences@localhost.invalid",
      "commit",
      "--no-gpg-sign",
      "--allow-empty",
      "-m",
      "Initialize release-a accepted state",
    ]);
  }

  private async assertNoSymlinks(root: string, skip = new Set<string>()): Promise<void> {
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        const metadata = await lstat(absolute);
        if (metadata.isSymbolicLink()) throw new Error(`Symlinks are not allowed in managed projects: ${absolute}`);
        if (metadata.isDirectory()) await walk(absolute);
      }
    };
    await walk(root);
  }

  private assertProject(projectId: string): void {
    ProjectIdSchema.parse(projectId);
  }

  private assertCandidatePath(candidate: string): void {
    if (!isWithin(this.config.candidatesRoot, candidate) || resolve(candidate) === resolve(this.config.candidatesRoot)) {
      throw new Error("Candidate path escaped its managed root");
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.mutationTail;
    let release = (): void => {};
    this.mutationTail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async git(cwd: string, args: readonly string[], maxStdoutBytes = 2 * 1_024 * 1_024): Promise<string> {
    const result = await runProcess({
      executable: this.config.gitCommand,
      args,
      cwd,
      env: isolatedToolEnvironment("host", this.config.runsRoot),
      timeoutMs: GIT_TIMEOUT_MS,
      maxStdoutBytes,
      maxStderrBytes: 256 * 1_024,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
      throw new Error(`Git ${args[0] ?? "command"} failed: ${detail.slice(0, 4_000)}`);
    }
    return result.stdout;
  }
}

function splitNull(value: string): string[] {
  return value
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
}
