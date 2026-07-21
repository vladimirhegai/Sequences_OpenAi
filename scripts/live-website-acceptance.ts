import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { RenderReceiptV1Schema, RunReceiptV1Schema } from "../apps/web/src/shared";
import {
  GenerateCliResultV1Schema,
  parseGenerateArguments,
  type GenerateCliResultV1,
} from "./generate";

const DEFAULT_PROMPT =
  "Create a 10-second SaaS launch video for Pulse, a deployment-monitoring product. Show an operator starting a safe rollout, a persistent progress workflow advancing, and a confirmation toast proving the release completed. Use no screenshots and invent no customer metrics or integrations. Make the action visibly cause the proof, with polished deterministic SaaS motion.";
const DEFAULT_ORIGIN = "http://127.0.0.1:4317";
const root = resolve(import.meta.dir, "..");
const requested = parseGenerateArguments(process.argv.slice(2));
if (requested.renderQuality && requested.renderQuality !== "draft") {
  throw new Error("Live website acceptance always renders at draft quality");
}
const acceptancePrompt = requested.prompt || DEFAULT_PROMPT;
const descriptorPath = join(root, "data", "local-server.json");
const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs).toISOString();
const evidenceRoot = join(
  root,
  "artifacts",
  "tests",
  "live-website",
  startedAt.replaceAll(":", "-"),
);

const LocalServerDescriptorSchema = z
  .object({
    version: z.literal("sequences.local-server.v1"),
    origin: z.string().url(),
    bootToken: z.string().min(32).max(256),
    pid: z.number().int().positive(),
    startedAt: z.string().datetime(),
  })
  .strict();

type PipeProcess = ReturnType<typeof spawnPipe>;

await mkdir(evidenceRoot, { recursive: true });
await Promise.all(
  ["generate.stdout.log", "generate.stderr.log", "server.stdout.log", "server.stderr.log"].map(
    (name) => writeFile(join(evidenceRoot, name), "", "utf8"),
  ),
);
console.error(
  "Starting opt-in live website acceptance. This uses the real default Luna/high author and performs a draft render.",
);

let server: PipeProcess | null = null;
let generator: PipeProcess | null = null;
let serverExitCode: number | null = null;
let generatorStdout = "";
let generatorStderr = "";
let failure: unknown = null;
let result: GenerateCliResultV1 | null = null;
let interrupted = false;

const stopChildren = (): void => {
  interrupted = true;
  generator?.kill();
  server?.kill();
};
process.once("SIGINT", stopChildren);
process.once("SIGTERM", stopChildren);

try {
  await assertNoLiveWebsite();
  await removeStaleDescriptor();

  const environment = defaultServerEnvironment();
  server = spawnPipe(["bun", "apps/web/src/server/index.ts"], environment);
  const ownedServer = server;
  const serverStdoutPromise = new Response(ownedServer.stdout).text();
  const serverStderrPromise = new Response(ownedServer.stderr).text();
  const serverExited = ownedServer.exited.then((exitCode) => {
    serverExitCode = exitCode;
    return exitCode;
  });

  try {
    const descriptor = await waitForOwnedServer(ownedServer);
    if (descriptor.origin !== DEFAULT_ORIGIN) {
      throw new Error(`Default server started at unexpected origin ${descriptor.origin}`);
    }

    generator = spawnPipe(
      [
        "bun",
        "scripts/generate.ts",
        "--render=draft",
        `--timeout-minutes=${String(requested.timeoutMinutes)}`,
        ...requested.imageFiles.flatMap((path) => ["--image", path]),
        acceptancePrompt,
      ],
      environment,
    );
    const ownedGenerator = generator;
    const generatorStdoutPromise = new Response(ownedGenerator.stdout).text();
    const generatorStderrPromise = new Response(ownedGenerator.stderr).text();
    const generatorExitCode = await ownedGenerator.exited;
    [generatorStdout, generatorStderr] = await Promise.all([
      generatorStdoutPromise,
      generatorStderrPromise,
    ]);
    await Promise.all([
      writeFile(join(evidenceRoot, "generate.stdout.log"), generatorStdout, "utf8"),
      writeFile(join(evidenceRoot, "generate.stderr.log"), generatorStderr, "utf8"),
    ]);
    if (interrupted) throw new Error("Live website acceptance was interrupted");
    if (generatorExitCode !== 0) {
      throw new Error(
        `The real website generation command exited with ${String(generatorExitCode)}: ${lastUsefulLine(generatorStderr)}`,
      );
    }

    result = GenerateCliResultV1Schema.parse(JSON.parse(generatorStdout) as unknown);
    await assertPersistedDelivery(result);
  } catch (error) {
    failure = error;
  } finally {
    if (serverExitCode === null) ownedServer.kill();
    await serverExited;
    const [serverStdout, serverStderr] = await Promise.all([
      serverStdoutPromise,
      serverStderrPromise,
    ]);
    await Promise.all([
      writeFile(join(evidenceRoot, "server.stdout.log"), serverStdout, "utf8"),
      writeFile(join(evidenceRoot, "server.stderr.log"), serverStderr, "utf8"),
    ]);
    await removeOwnedDescriptor(ownedServer.pid);
  }
} catch (error) {
  failure ??= error;
} finally {
  process.removeListener("SIGINT", stopChildren);
  process.removeListener("SIGTERM", stopChildren);
}

const finishedAt = new Date().toISOString();
if (failure) {
  const runReceiptPath = await latestReceiptPath(
    join(root, "data", "runs", "release-a"),
    /^run_[0-9a-f]{32}$/,
  );
  const renderReceiptPath = await latestReceiptPath(
    join(root, "artifacts", "renders", "release-a"),
    /^render_[0-9a-f]{32}$/,
  );
  const receipt = {
    version: "sequences.live-website-acceptance.v1",
    state: "failed",
    startedAt,
    finishedAt,
    prompt: acceptancePrompt,
    imageFiles: requested.imageFiles,
    error: errorMessage(failure),
    runReceiptPath,
    renderReceiptPath,
    evidenceRoot: relativePath(evidenceRoot),
  };
  const acceptanceReceiptPath = join(evidenceRoot, "receipt.json");
  await writeFile(acceptanceReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.error(
    [
      `Live website acceptance failed: ${receipt.error}`,
      `Acceptance receipt: ${relativePath(acceptanceReceiptPath)}`,
      `Generator log: ${relativePath(join(evidenceRoot, "generate.stderr.log"))}`,
      `Server log: ${relativePath(join(evidenceRoot, "server.stderr.log"))}`,
      runReceiptPath ? `Run receipt: ${runReceiptPath}` : "Run receipt: none created",
      renderReceiptPath ? `Render receipt: ${renderReceiptPath}` : "Render receipt: none created",
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  const accepted = result!;
  const receipt = {
    version: "sequences.live-website-acceptance.v1",
    state: "passed",
    startedAt,
    finishedAt,
    prompt: acceptancePrompt,
    imageFiles: requested.imageFiles,
    execution: accepted.execution,
    jobId: accepted.jobId,
    renderId: accepted.render?.renderId ?? null,
    runReceiptPath: accepted.runReceiptPath,
    renderReceiptPath: accepted.renderReceiptPath,
    videoPath: accepted.render?.artifacts?.video.path ?? null,
    sourceBundlePath: accepted.render?.artifacts?.sourceBundle.path ?? null,
    evidenceRoot: relativePath(evidenceRoot),
  };
  const acceptanceReceiptPath = join(evidenceRoot, "receipt.json");
  await writeFile(acceptanceReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(
    [
      "Live website acceptance passed.",
      `Run receipt: ${accepted.runReceiptPath}`,
      `Render receipt: ${accepted.renderReceiptPath}`,
      `Verified MP4: ${accepted.render!.artifacts!.video.path}`,
      `Verified source: ${accepted.render!.artifacts!.sourceBundle.path}`,
      `Acceptance receipt: ${relativePath(acceptanceReceiptPath)}`,
    ].join("\n"),
  );
}

async function assertPersistedDelivery(value: GenerateCliResultV1): Promise<void> {
  const expectedSandbox = process.platform === "win32" ? "danger-full-access" : "workspace-write";
  if (value.execution.sandbox !== expectedSandbox) {
    throw new Error(
      `Production server used ${value.execution.sandbox}; expected default ${expectedSandbox}`,
    );
  }
  const job = value.jobReceipt;
  if (job.state !== "applied" || job.changedFiles.length === 0 || !job.qa?.ok) {
    throw new Error("Generation did not finish applied with authored files and passing QA");
  }
  if (!job.candidateCommit || job.candidateCommit !== job.acceptedCommit) {
    throw new Error("Generation did not promote the exact verified candidate commit");
  }
  const persistedRun = RunReceiptV1Schema.parse(
    JSON.parse(await readFile(withinWorkspace(value.runReceiptPath), "utf8")) as unknown,
  );
  if (persistedRun.jobId !== job.jobId || persistedRun.state !== "applied") {
    throw new Error("Persisted run receipt does not match the applied HTTP response");
  }

  const render = value.render;
  if (!render || render.state !== "completed" || !render.artifacts || !value.renderReceiptPath) {
    throw new Error("Draft render did not finish with verified MP4 and source artifacts");
  }
  const persistedRender = RenderReceiptV1Schema.parse(
    JSON.parse(await readFile(withinWorkspace(value.renderReceiptPath), "utf8")) as unknown,
  );
  if (persistedRender.renderId !== render.renderId || persistedRender.state !== "completed") {
    throw new Error("Persisted render receipt does not match the completed HTTP response");
  }

  const video = await stat(withinWorkspace(render.artifacts.video.path));
  if (!video.isFile() || video.size !== render.artifacts.video.bytes) {
    throw new Error("Verified MP4 is missing or does not match its render receipt");
  }
  const source = await stat(withinWorkspace(render.artifacts.sourceBundle.path));
  if (!source.isFile() || source.size !== render.artifacts.sourceBundle.bytes) {
    throw new Error("Verified source bundle is missing or does not match its render receipt");
  }
}

async function waitForOwnedServer(process: PipeProcess) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (serverExitCode !== null) {
      throw new Error(`Production server exited during startup with ${String(serverExitCode)}`);
    }
    try {
      const descriptor = LocalServerDescriptorSchema.parse(
        JSON.parse(await readFile(descriptorPath, "utf8")) as unknown,
      );
      if (
        descriptor.pid === process.pid &&
        Date.parse(descriptor.startedAt) >= startedAtMs - 1_000
      ) {
        const health = await fetch(`${descriptor.origin}/api/v1/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (health.ok) return descriptor;
      }
    } catch {
      // Server startup is still in progress; the deadline remains authoritative.
    }
    await Bun.sleep(250);
  }
  throw new Error("Production server did not become healthy within 90 seconds");
}

async function assertNoLiveWebsite(): Promise<void> {
  try {
    const response = await fetch(`${DEFAULT_ORIGIN}/api/v1/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) {
      throw new Error(
        `A website server is already running at ${DEFAULT_ORIGIN}; stop it so this test can own the production process`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already running")) throw error;
  }
}

async function removeStaleDescriptor(): Promise<void> {
  try {
    const descriptor = LocalServerDescriptorSchema.parse(
      JSON.parse(await readFile(descriptorPath, "utf8")) as unknown,
    );
    // Windows PIDs are reusable and Bun's process.kill(pid, 0) can report a
    // reused, unrelated process as alive. The descriptor belongs to a website
    // server only when that process identity is paired with a healthy server at
    // the recorded origin; otherwise the descriptor is stale coordination data.
    if (processIsAlive(descriptor.pid) && (await websiteIsHealthy(descriptor.origin))) {
      throw new Error(
        `Server descriptor belongs to live process ${String(descriptor.pid)}; stop it before running acceptance`,
      );
    }
    await rm(descriptorPath, { force: true });
  } catch (error) {
    if (isMissing(error)) return;
    if (error instanceof z.ZodError) {
      throw new Error(
        `Refusing to replace invalid server descriptor at ${relativePath(descriptorPath)}`,
      );
    }
    throw error;
  }
}

async function websiteIsHealthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin.replace(/\/$/, "")}/api/v1/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function removeOwnedDescriptor(pid: number): Promise<void> {
  try {
    const descriptor = LocalServerDescriptorSchema.parse(
      JSON.parse(await readFile(descriptorPath, "utf8")) as unknown,
    );
    if (descriptor.pid === pid) await rm(descriptorPath, { force: true });
  } catch (error) {
    if (!isMissing(error) && !(error instanceof z.ZodError)) throw error;
  }
}

function defaultServerEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const key of [
    "SEQUENCES_PORT",
    "SEQUENCES_CODEX_COMMAND",
    "SEQUENCES_CODEX_SANDBOX",
    "SEQUENCES_CODEX_MODEL",
    "SEQUENCES_CODEX_EFFORT",
    "SEQUENCES_HYPERFRAMES_COMMAND",
    "SEQUENCES_SKILLS_MANIFEST",
    "SEQUENCES_REGISTRY_MANIFEST",
    "HYPERFRAMES_NO_AUTO_INSTALL",
    "HYPERFRAMES_NO_UPDATE_CHECK",
    "HYPERFRAMES_NO_TELEMETRY",
    "HYPERFRAMES_SKIP_SKILLS",
  ]) {
    delete environment[key];
  }
  return environment;
}

function spawnPipe(command: string[], environment: Record<string, string>) {
  return Bun.spawn(command, {
    cwd: root,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
}

async function latestReceiptPath(parent: string, directoryPattern: RegExp): Promise<string | null> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const candidates: Array<{ path: string; modified: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !directoryPattern.test(entry.name)) continue;
    const path = join(parent, entry.name, "receipt.json");
    try {
      const info = await stat(path);
      if (info.isFile() && info.mtimeMs >= startedAtMs - 1_000) {
        candidates.push({ path, modified: info.mtimeMs });
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  candidates.sort((left, right) => right.modified - left.modified);
  return candidates[0] ? relativePath(candidates[0].path) : null;
}

function withinWorkspace(path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === "." || rel.startsWith("..") || resolve(root, rel) !== absolute) {
    throw new Error(`Artifact path escaped the workspace: ${path}`);
  }
  return absolute;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function relativePath(path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function lastUsefulLine(value: string): string {
  return value.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "no diagnostic output";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
