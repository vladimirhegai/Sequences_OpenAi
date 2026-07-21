import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { PHASE_MANIFESTS, type PhaseCheck } from "./phase-manifests";

const root = resolve(import.meta.dir, "..");
const requested = Number(process.argv[2]);
const selectedManifest = PHASE_MANIFESTS.get(requested);
if (!selectedManifest || !Number.isInteger(requested)) {
  console.error(
    `Unknown phase ${process.argv[2] ?? "<missing>"}. Available: ${[...PHASE_MANIFESTS.keys()].join(", ")}`,
  );
  process.exit(2);
}
const manifest = selectedManifest;

const phaseRoot = join(root, "artifacts", "tests", `phase-${manifest.phase}`);
const latestRoot = join(phaseRoot, "latest");
await rotateLatest(phaseRoot, latestRoot);
await mkdir(join(latestRoot, "logs"), { recursive: true });

const startedAt = new Date().toISOString();
const started = Date.now();
const results: CheckReceipt[] = [];
const versions = {
  bun: commandVersion(["bun", "--version"]),
  node: commandVersion(["node", "--version"]),
  git: commandVersion(["git", "--version"]),
  ffmpeg: commandVersion(["ffmpeg", "-version"]),
  ffprobe: commandVersion(["ffprobe", "-version"]),
  hyperframes: commandVersion(["bun", "scripts/hyperframes.ts", "--version"]),
};

await writeReceipt("running");
console.log(`Phase ${manifest.phase}: ${manifest.title}`);
for (const check of manifest.checks) {
  console.log(`\n[${check.id}] ${check.label}`);
  const result = await runCheck(check);
  results.push(result);
  console.log(`${result.status.toUpperCase()} in ${result.durationMs}ms`);
  await writeReceipt(result.status === "failed" ? "failed" : "running");
  if (result.status === "failed") break;
}

const status =
  results.length === manifest.checks.length && results.every((check) => check.status === "passed")
    ? "passed"
    : "failed";
await writeReceipt(status);
console.log(
  `\nPhase ${manifest.phase} ${status}. Receipt: ${relative(root, join(latestRoot, "receipt.json"))}`,
);
if (status !== "passed") process.exitCode = 1;

interface CheckReceipt {
  id: string;
  label: string;
  status: "passed" | "failed";
  command: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
}

async function runCheck(check: PhaseCheck): Promise<CheckReceipt> {
  const checkStarted = Date.now();
  const checkStartedAt = new Date().toISOString();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  environment.SEQUENCES_PHASE_EVIDENCE_DIR = latestRoot;
  environment.DO_NOT_TRACK = "1";
  environment.HYPERFRAMES_NO_AUTO_INSTALL = "1";
  environment.HYPERFRAMES_NO_UPDATE_CHECK = "1";
  environment.HYPERFRAMES_NO_TELEMETRY = "1";
  environment.HYPERFRAMES_SKIP_SKILLS = "1";
  const child = Bun.spawn(check.command, {
    cwd: root,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, check.timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const stdoutPath = join(latestRoot, "logs", `${check.id}.stdout.log`);
  const stderrPath = join(latestRoot, "logs", `${check.id}.stderr.log`);
  await Promise.all([writeFile(stdoutPath, stdout, "utf8"), writeFile(stderrPath, stderr, "utf8")]);
  printCapturedOutput("stdout", stdout, exitCode === 0 && !timedOut);
  printCapturedOutput("stderr", stderr, exitCode === 0 && !timedOut);
  return {
    id: check.id,
    label: check.label,
    status: exitCode === 0 && !timedOut ? "passed" : "failed",
    command: [...check.command],
    startedAt: checkStartedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - checkStarted,
    exitCode,
    timedOut,
    stdoutPath: posixRelative(stdoutPath),
    stderrPath: posixRelative(stderrPath),
  };
}

function printCapturedOutput(stream: "stdout" | "stderr", value: string, passed: boolean): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (passed && Buffer.byteLength(trimmed, "utf8") > 8 * 1_024) {
    console.log(`${stream} exceeded 8 KiB and is preserved in the check log.`);
    return;
  }
  const visible =
    Buffer.byteLength(trimmed, "utf8") > 16 * 1_024 ? trimmed.slice(-16 * 1_024) : trimmed;
  if (stream === "stderr") console.error(visible);
  else console.log(visible);
}

async function writeReceipt(status: "running" | "passed" | "failed"): Promise<void> {
  const receipt = {
    version: "sequences.phase-test-receipt.v1",
    phase: manifest.phase,
    title: manifest.title,
    status,
    startedAt,
    updatedAt: new Date().toISOString(),
    finishedAt: status === "running" ? null : new Date().toISOString(),
    durationMs: Date.now() - started,
    versions,
    checks: results,
    evidencePaths: status === "running" ? [] : await evidencePaths(latestRoot),
  };
  await writeFile(
    join(latestRoot, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
}

async function evidencePaths(directory: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path !== join(latestRoot, "receipt.json"))
        output.push(posixRelative(path));
    }
  };
  await walk(directory);
  return output.sort();
}

async function rotateLatest(parent: string, latest: string): Promise<void> {
  try {
    await stat(latest);
  } catch {
    await mkdir(parent, { recursive: true });
    return;
  }
  const history = join(parent, "history");
  await mkdir(history, { recursive: true });
  await rename(latest, join(history, new Date().toISOString().replaceAll(":", "-")));
}

function commandVersion(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  return (
    (result.stdout.toString().trim() || result.stderr.toString().trim())
      .split(/\r?\n/)[0]
      ?.slice(0, 300) ?? "unknown"
  );
}

function posixRelative(path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}
