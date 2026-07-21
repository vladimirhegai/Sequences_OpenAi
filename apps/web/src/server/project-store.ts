import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  GitCommitSchema,
  ImageInputV1Schema,
  JobIdSchema,
  PROJECT_ID,
  ProjectIdSchema,
  RenderIdSchema,
  type ImageInputV1,
} from "../shared";
import type { ServerConfig } from "./config";
import { ApiProblem } from "./errors";
import { existingFileWithin, isWithin, managedPath, posixPath, sha256 } from "./files";
import { inspectImageInput } from "./image-input";
import { isolatedToolEnvironment, runProcess } from "./process-runner";

const GIT_TIMEOUT_MS = 60_000;

export class ProjectStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly config: ServerConfig) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.config.candidatesRoot, { recursive: true }),
      mkdir(this.config.runsRoot, { recursive: true }),
      mkdir(this.config.rendersRoot, { recursive: true }),
      mkdir(this.config.renderWorktreesRoot, { recursive: true }),
      mkdir(this.config.imageInputsRoot, { recursive: true }),
    ]);
    try {
      await stat(this.config.acceptedRoot);
    } catch {
      await this.seedAcceptedProject();
    }
    await this.assertNoSymlinks(this.config.acceptedRoot);
    await this.ensureGitRepository();
    await this.checkpointAcceptedChanges("Checkpoint local accepted-source edits on startup");
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

  async storeImageInput(
    bytes: Uint8Array,
    declaredMediaType: string | null,
  ): Promise<ImageInputV1> {
    const inspected = inspectImageInput(bytes, declaredMediaType);
    const path = `assets/derived/input-${randomUUID().replaceAll("-", "")}.${inspected.extension}`;
    const target = managedPath(this.config.imageInputsRoot, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    return ImageInputV1Schema.parse({
      path,
      mediaType: inspected.mediaType,
      bytes: bytes.byteLength,
      width: inspected.width,
      height: inspected.height,
      sha256: sha256(bytes),
    });
  }

  async readImageInput(path: string): Promise<ImageInputV1> {
    assertStagedImagePath(path);
    const source = await existingFileWithin(this.config.imageInputsRoot, path);
    const bytes = await readFile(source);
    const inspected = inspectImageInput(bytes, mediaTypeForPath(path));
    return ImageInputV1Schema.parse({
      path,
      mediaType: inspected.mediaType,
      bytes: bytes.byteLength,
      width: inspected.width,
      height: inspected.height,
      sha256: sha256(bytes),
    });
  }

  async discardImageInput(path: string): Promise<void> {
    assertStagedImagePath(path);
    const target = managedPath(this.config.imageInputsRoot, ...path.split("/"));
    await rm(target, { force: true });
  }

  renderRoot(renderId: string): string {
    RenderIdSchema.parse(renderId);
    return managedPath(this.config.rendersRoot, renderId);
  }

  renderWorktreeRoot(renderId: string): string {
    RenderIdSchema.parse(renderId);
    return managedPath(this.config.renderWorktreesRoot, renderId);
  }

  async acceptedCommit(projectId = PROJECT_ID): Promise<string> {
    this.assertProject(projectId);
    return GitCommitSchema.parse(
      (await this.git(this.config.acceptedRoot, ["rev-parse", "HEAD"])).trim(),
    );
  }

  async acceptedIsClean(): Promise<boolean> {
    return (
      (
        await this.git(this.config.acceptedRoot, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ])
      ).trim() === ""
    );
  }

  /**
   * Make the source currently visible in the website a durable Git base.
   *
   * HyperFrames-compatible tools can edit the managed accepted directory
   * directly. Leaving those edits uncommitted makes the website preview one
   * source while candidate worktrees and renders use an older commit. Snapshot
   * them before generation/render so every entry point sees identical bytes.
   */
  async checkpointAcceptedChanges(message: string): Promise<string> {
    return this.withMutationLock(async () => {
      if (await this.acceptedIsClean()) return this.acceptedCommit();
      await this.git(this.config.acceptedRoot, ["add", "--all", "--", "."]);
      await this.git(this.config.acceptedRoot, [
        "-c",
        "user.name=Sequences Host",
        "-c",
        "user.email=sequences@localhost.invalid",
        "commit",
        "--no-gpg-sign",
        "-m",
        message,
      ]);
      return this.acceptedCommit();
    });
  }

  async createCandidate(jobId: string, baseCommit: string): Promise<string> {
    JobIdSchema.parse(jobId);
    GitCommitSchema.parse(baseCommit);
    const candidate = this.candidateRoot(jobId);
    try {
      await stat(candidate);
      throw new ApiProblem(
        409,
        "candidate_exists",
        "A candidate workspace already exists for this job",
      );
    } catch (error) {
      if (error instanceof ApiProblem) throw error;
    }
    await mkdir(this.config.candidatesRoot, { recursive: true });
    await this.git(this.config.acceptedRoot, [
      "worktree",
      "add",
      "--detach",
      candidate,
      baseCommit,
    ]);
    await this.assertNoSymlinks(candidate, new Set([".git"]));
    return candidate;
  }

  /**
   * Create the baseline for a brand-new video build. The accepted project is
   * used only as the Git parent so promotion stays a fast-forward; none of
   * its creative source is exposed to Luna. The candidate gets the technical
   * HyperFrames seed files plus the generic, contract-valid SaaS starter
   * shell: a host composition and a product-world sub-composition with stable
   * regions for Luna to rebrand, restyle, and choreograph instead of
   * reinventing the entire HTML/CSS foundation on every run. The shell
   * deliberately ships no index.motion.json; its presence is the disk-level
   * proof that authoring actually happened.
   */
  async createFreshCandidate(
    jobId: string,
    baseCommit: string,
    imagePaths: readonly string[] = [],
  ): Promise<{ candidate: string; baseCommit: string }> {
    const candidate = await this.createCandidate(jobId, baseCommit);
    const entries = await readdir(candidate, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".gitignore") continue;
      // Native Windows can briefly hold freshly materialized worktree files
      // while indexing them. Node retries EBUSY/EPERM only when maxRetries is
      // explicit; without it, Generate can fail before authoring even starts.
      await rm(join(candidate, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }

    const seed = resolve(this.config.seedRoot);
    for (const file of ["AGENTS.md", "hyperframes.json", "package.json", "meta.json"]) {
      await cp(join(seed, file), join(candidate, file), { force: true });
    }
    await cp(join(seed, "assets", "vendor"), join(candidate, "assets", "vendor"), {
      recursive: true,
      force: true,
    });
    await cp(join(seed, "assets", "fonts"), join(candidate, "assets", "fonts"), {
      recursive: true,
      force: true,
    });

    const shell = resolve(this.config.shellRoot);
    if (!isWithin(this.config.workspaceRoot, shell)) {
      throw new Error("The configured SaaS starter shell is outside the workspace");
    }
    await this.assertNoSymlinks(shell);
    await cp(join(shell, "index.html"), join(candidate, "index.html"), { force: true });
    await cp(join(shell, "compositions"), join(candidate, "compositions"), {
      recursive: true,
      force: true,
    });
    for (const imagePath of imagePaths) {
      const source = await existingFileWithin(this.config.imageInputsRoot, imagePath);
      const destination = managedPath(candidate, ...imagePath.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { force: true });
    }
    await writeFile(
      join(candidate, "sequence.json"),
      `${JSON.stringify(
        {
          version: "sequences.sequence.v1",
          format: { width: 1920, height: 1080, fps: 30, targetDuration: 5 },
          concept: {
            summary:
              "Generic SaaS starter shell; replace this concept with the requested launch story.",
            hierarchy: ["Rebrand and choreograph the starter shell into the new video's beats."],
            motionGrammar: ["Use deterministic, seek-safe HyperFrames motion."],
            rejectedChoices: [],
          },
          beats: [
            {
              id: "fresh-build",
              role: "hook",
              start: 0,
              duration: 5,
              purpose: "Starter shell hero frame; replace with the requested video.",
              claims: [],
              entities: [],
              sourceIds: [],
              musicAnchors: [],
              proofTimes: [0],
              implementationFiles: ["index.html", "compositions/02-compose.html"],
            },
          ],
          transitions: [],
          overlapIntents: [],
          revision: null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await this.assertNoSymlinks(candidate, new Set([".git"]));
    await this.git(candidate, ["add", "--all", "--", "."]);
    await this.git(candidate, [
      "-c",
      "user.name=Sequences Host",
      "-c",
      "user.email=sequences@localhost.invalid",
      "commit",
      "--no-gpg-sign",
      "--allow-empty",
      "-m",
      `fresh build baseline: ${jobId}`,
    ]);
    return {
      candidate,
      baseCommit: GitCommitSchema.parse((await this.git(candidate, ["rev-parse", "HEAD"])).trim()),
    };
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

  async candidatePatch(
    candidate: string,
    baseCommit: string,
    candidateCommit: string,
  ): Promise<string> {
    this.assertCandidatePath(candidate);
    GitCommitSchema.parse(baseCommit);
    GitCommitSchema.parse(candidateCommit);
    return this.git(
      candidate,
      ["diff", "--binary", baseCommit, candidateCommit, "--"],
      32 * 1_024 * 1_024,
    );
  }

  async applyCandidate(baseCommit: string, candidateCommit: string): Promise<string> {
    return this.withMutationLock(async () => {
      const current = await this.acceptedCommit();
      if (!(await this.acceptedIsClean()) || !(await this.isAncestor(current, baseCommit))) {
        throw new ApiProblem(
          409,
          "stale_base",
          "Accepted source changed after this candidate was created",
        );
      }
      await this.git(this.config.acceptedRoot, [
        "merge-base",
        "--is-ancestor",
        baseCommit,
        candidateCommit,
      ]);
      await this.git(this.config.acceptedRoot, [
        "merge",
        "--ff-only",
        "--no-edit",
        candidateCommit,
      ]);
      const accepted = await this.acceptedCommit();
      if (accepted !== candidateCommit) {
        throw new Error(
          "Git promotion completed without advancing accepted HEAD to the candidate commit",
        );
      }
      return accepted;
    });
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(this.config.acceptedRoot, [
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async removeCandidate(jobId: string): Promise<void> {
    const candidate = this.candidateRoot(jobId);
    this.assertCandidatePath(candidate);
    await this.git(this.config.acceptedRoot, ["worktree", "remove", "--force", candidate]);
  }

  async createRenderSnapshot(renderId: string, commit: string): Promise<string> {
    RenderIdSchema.parse(renderId);
    GitCommitSchema.parse(commit);
    const snapshot = this.renderWorktreeRoot(renderId);
    try {
      await stat(snapshot);
      throw new ApiProblem(
        409,
        "render_snapshot_exists",
        "A render snapshot already exists for this job",
      );
    } catch (error) {
      if (error instanceof ApiProblem) throw error;
    }
    await this.git(this.config.acceptedRoot, ["worktree", "add", "--detach", snapshot, commit]);
    await this.assertNoSymlinks(snapshot, new Set([".git"]));
    return snapshot;
  }

  async archiveCommit(commit: string, outputPath: string): Promise<void> {
    GitCommitSchema.parse(commit);
    if (!isWithin(this.config.rendersRoot, outputPath)) {
      throw new Error("Source bundle output escaped the managed render root");
    }
    await this.git(this.config.acceptedRoot, [
      "archive",
      "--format=zip",
      `--output=${resolve(outputPath)}`,
      commit,
    ]);
  }

  async removeRenderSnapshot(renderId: string): Promise<void> {
    const snapshot = this.renderWorktreeRoot(renderId);
    try {
      await stat(snapshot);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    try {
      await this.git(this.config.acceptedRoot, ["worktree", "remove", "--force", snapshot]);
    } catch {
      // A cancelled renderer can finish tearing down the worktree's .git file
      // before Git processes the removal. The path is still a schema-validated
      // child of renderWorktreesRoot, so remove that managed residue and prune
      // Git's stale administrative entry.
      await rm(snapshot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await this.git(this.config.acceptedRoot, ["worktree", "prune"]);
    }
  }

  async listFiles(projectId = PROJECT_ID): Promise<string[]> {
    this.assertProject(projectId);
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (
          [
            ".git",
            ".agents",
            ".hyperframes",
            ".thumbnails",
            "node_modules",
            "renders",
            "snapshots",
          ].includes(entry.name)
        )
          continue;
        const absolute = join(directory, entry.name);
        if (entry.isSymbolicLink())
          throw new Error(`Symlinks are forbidden in accepted projects: ${absolute}`);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile())
          files.push(posixPath(relative(this.config.acceptedRoot, absolute)));
        if (files.length > 5_000)
          throw new Error("Project file count exceeds the 5,000-file safety limit");
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
      const inside = (
        await this.git(this.config.acceptedRoot, ["rev-parse", "--show-toplevel"])
      ).trim();
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
        if (metadata.isSymbolicLink())
          throw new Error(`Symlinks are not allowed in managed projects: ${absolute}`);
        if (metadata.isDirectory()) await walk(absolute);
      }
    };
    await walk(root);
  }

  private assertProject(projectId: string): void {
    ProjectIdSchema.parse(projectId);
  }

  private assertCandidatePath(candidate: string): void {
    if (
      !isWithin(this.config.candidatesRoot, candidate) ||
      resolve(candidate) === resolve(this.config.candidatesRoot)
    ) {
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

  private async git(
    cwd: string,
    args: readonly string[],
    maxStdoutBytes = 2 * 1_024 * 1_024,
  ): Promise<string> {
    const safeArgs = ["-c", `safe.directory=${resolve(cwd)}`, ...args];
    const result = await runProcess({
      executable: this.config.gitCommand,
      args: safeArgs,
      cwd,
      env: isolatedToolEnvironment("host", this.config.runsRoot),
      timeoutMs: GIT_TIMEOUT_MS,
      maxStdoutBytes,
      maxStderrBytes: 256 * 1_024,
    });
    if (result.exitCode !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
      throw new Error(`Git ${args[0] ?? "command"} failed: ${detail.slice(0, 4_000)}`);
    }
    return result.stdout;
  }
}

function assertStagedImagePath(path: string): void {
  if (!/^assets\/derived\/input-[0-9a-f]{32}\.(?:png|jpg|webp)$/.test(path)) {
    throw new ApiProblem(422, "invalid_image_input", "The image input path is not host-managed");
  }
}

function mediaTypeForPath(path: string): ImageInputV1["mediaType"] {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg")) return "image/jpeg";
  return "image/webp";
}

function splitNull(value: string): string[] {
  return value
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
}
