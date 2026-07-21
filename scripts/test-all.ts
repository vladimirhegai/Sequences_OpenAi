import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { COMPLETED_PHASES } from "./phase-manifests";

const root = resolve(import.meta.dir, "..");
const allRoot = join(root, "artifacts", "tests", "all");
const latest = join(allRoot, "latest");
await rotateLatest();
await mkdir(latest, { recursive: true });
const startedAt = new Date().toISOString();
const started = Date.now();
const phases: Array<{ phase: number; status: "passed" | "failed"; receiptPath: string }> = [];

for (const phase of COMPLETED_PHASES) {
  const child = Bun.spawn(["bun", "scripts/test-phase.ts", String(phase)], {
    cwd: root,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  });
  const exitCode = await child.exited;
  phases.push({
    phase,
    status: exitCode === 0 ? "passed" : "failed",
    receiptPath: `artifacts/tests/phase-${phase}/latest/receipt.json`,
  });
  if (exitCode !== 0) break;
}

const status =
  phases.length === COMPLETED_PHASES.length && phases.every((phase) => phase.status === "passed")
    ? "passed"
    : "failed";
await writeFile(
  join(latest, "receipt.json"),
  `${JSON.stringify(
    {
      version: "sequences.all-tests-receipt.v1",
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      completedPhases: [...COMPLETED_PHASES],
      phases,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(
  `All completed phases ${status}. Receipt: ${relative(root, join(latest, "receipt.json"))}`,
);
if (status !== "passed") process.exitCode = 1;

async function rotateLatest(): Promise<void> {
  try {
    await stat(latest);
  } catch {
    await mkdir(allRoot, { recursive: true });
    return;
  }
  const history = join(allRoot, "history");
  await mkdir(history, { recursive: true });
  await rename(latest, join(history, new Date().toISOString().replaceAll(":", "-")));
}
