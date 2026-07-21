import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSequencesRuntime } from "../apps/web/src/server/app";

const root = resolve(import.meta.dir, "..");
const tempRoot = mkdtempSync(join(tmpdir(), "sequences-project-smoke-"));
const origin = "http://127.0.0.1:4317";
const host = "127.0.0.1:4317";
const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

function add(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function command(args: string[]): { ok: boolean; output: string } {
  const result = Bun.spawnSync(args, {
    cwd: root,
    env: {
      ...process.env,
      DO_NOT_TRACK: "1",
      HYPERFRAMES_NO_AUTO_INSTALL: "1",
      HYPERFRAMES_NO_TELEMETRY: "1",
      HYPERFRAMES_NO_UPDATE_CHECK: "1",
      HYPERFRAMES_SKIP_SKILLS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  return { ok: result.exitCode === 0, output: stdout || stderr };
}

try {
  const codex = command(["codex", "--version"]);
  add("Codex CLI", codex.ok && codex.output.startsWith("codex-cli "), codex.output || "not found");

  const hyperframes = command([
    "node",
    join(root, "node_modules", "hyperframes", "dist", "cli.js"),
    "--version",
  ]);
  add(
    "HyperFrames CLI",
    hyperframes.ok && hyperframes.output === "0.7.56",
    hyperframes.output || "not found",
  );

  const runtime = await createSequencesRuntime({
    workspaceRoot: root,
    acceptedRoot: join(tempRoot, "accepted"),
    seedRoot: join(root, "fixtures", "release-a"),
    candidatesRoot: join(tempRoot, "candidates"),
    runsRoot: join(tempRoot, "runs"),
    rendersRoot: join(tempRoot, "renders"),
    renderWorktreesRoot: join(tempRoot, "render-worktrees"),
    skillsRoot: join(root, ".agents", "skills"),
    skillsManifestPath: join(root, ".agents", "skills-manifest.json"),
    registryManifestPath: join(root, ".agents", "registry", "registry.json"),
    expectedOrigin: origin,
    expectedHost: host,
    bootToken: "b".repeat(43),
    sessionToken: "s".repeat(43),
    csrfToken: "c".repeat(43),
    staticAccessToken: "f".repeat(43),
  });

  const baseHeaders = { Host: host };
  const health = await runtime.app.request("/api/v1/health", { headers: baseHeaders });
  add("Server health", health.status === 200, `HTTP ${health.status}`);

  const session = await runtime.app.request("/api/v1/session", {
    method: "POST",
    headers: { ...baseHeaders, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ version: "sequences.create-session.v1", bootToken: "b".repeat(43) }),
  });
  const sessionBody = (await session.json()) as { csrfToken?: string };
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  add(
    "Local session",
    session.status === 200 && Boolean(sessionBody.csrfToken) && Boolean(cookie),
    `HTTP ${session.status}`,
  );

  const bootstrap = await runtime.app.request("/api/v1/bootstrap", {
    headers: { ...baseHeaders, Cookie: cookie },
  });
  const bootstrapBody = (await bootstrap.json()) as {
    capabilities?: { available?: boolean; skillProfileVersion?: string; skillProfileId?: string };
    project?: { acceptedSource?: { kind?: string }; renders?: unknown[] };
    sampleUrl?: string;
  };
  add(
    "Workspace bootstrap",
    bootstrap.status === 200 &&
      bootstrapBody.capabilities?.available === true &&
      bootstrapBody.capabilities.skillProfileVersion === "sequences.skill-profile.v1" &&
      bootstrapBody.capabilities.skillProfileId === "sequences-saas-launch-local-v1" &&
      bootstrapBody.project?.acceptedSource?.kind === "prepared_sample" &&
      Array.isArray(bootstrapBody.project.renders),
    `HTTP ${bootstrap.status}`,
  );

  const sample = bootstrapBody.sampleUrl
    ? await runtime.app.request(bootstrapBody.sampleUrl, {
        headers: { ...baseHeaders, Origin: "null" },
      })
    : null;
  add("Sample composition route", sample?.status === 200, `HTTP ${sample?.status ?? 0}`);

  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
