import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const root = resolve(import.meta.dir, "..");
const expectedHyperframesVersion = "0.7.56";
const expectedSkillsDigest = "b28d6cffd6a53b4e9783653b8f20b67b01e209eb943085217a25f1ce95ac8ba1";
const checks: Check[] = [];

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

function addCommandCheck(name: string, args: string[], predicate?: (output: string) => boolean): void {
  const result = command(args);
  checks.push({
    name,
    ok: result.ok && (predicate?.(result.output) ?? true),
    detail: result.output.split(/\r?\n/, 1)[0] || "not found",
  });
}

addCommandCheck("Bun", ["bun", "--version"]);
addCommandCheck("Node.js >= 22", ["node", "--version"], (output) => {
  const major = Number.parseInt(output.replace(/^v/, "").split(".")[0] ?? "0", 10);
  return major >= 22;
});
addCommandCheck("Git", ["git", "--version"]);
addCommandCheck("Codex CLI", ["codex", "--version"]);
addCommandCheck("FFmpeg", ["ffmpeg", "-version"]);
addCommandCheck("FFprobe", ["ffprobe", "-version"]);

const cliPath = join(root, "node_modules", "hyperframes", "dist", "cli.js");
addCommandCheck("Hyperframes CLI 0.7.56", ["node", cliPath, "--version"], (output) =>
  output.split(/\r?\n/).some((line) => line.trim() === expectedHyperframesVersion),
);

for (const packageName of [
  "core",
  "engine",
  "lint",
  "parsers",
  "player",
  "producer",
  "sdk",
  "shader-transitions",
  "studio-server",
]) {
  const packagePath = join(root, "node_modules", "@hyperframes", packageName, "package.json");
  let version = "missing";
  if (existsSync(packagePath)) {
    version = (JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string }).version ?? "unknown";
  }
  checks.push({
    name: `@hyperframes/${packageName}`,
    ok: version === expectedHyperframesVersion,
    detail: version,
  });
}

const embeddedStudioPath = join(root, "node_modules", "hyperframes", "dist", "studio", "index.html");
checks.push({
  name: "Official embedded Hyperframes Studio",
  ok: existsSync(embeddedStudioPath),
  detail: existsSync(embeddedStudioPath) ? "bundled with hyperframes 0.7.56" : "missing",
});

const skillsManifest = join(root, ".agents", "skills-manifest.json");
let skillsDetail = "missing";
let skillsOk = false;
if (existsSync(skillsManifest)) {
  const bytes = readFileSync(skillsManifest);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = JSON.parse(bytes.toString("utf8")) as {
    skills?: Record<string, unknown>;
  };
  const skillCount = Object.keys(manifest.skills ?? {}).length;
  skillsDetail = `${skillCount} skills · sha256:${digest.slice(0, 12)}`;
  skillsOk = digest === expectedSkillsDigest && skillCount === 8;
}
checks.push({ name: "Pinned Hyperframes skills", ok: skillsOk, detail: skillsDetail });

const registryPath = join(root, ".agents", "registry", "registry.json");
let registryDetail = "missing";
let registryOk = false;
if (existsSync(registryPath)) {
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    items?: Array<{ type?: string }>;
  };
  const counts = new Map<string, number>();
  for (const item of registry.items ?? []) counts.set(item.type ?? "unknown", (counts.get(item.type ?? "unknown") ?? 0) + 1);
  registryDetail = `${registry.items?.length ?? 0} registered items`;
  registryOk =
    counts.get("hyperframes:block") === 109 &&
    counts.get("hyperframes:component") === 25 &&
    counts.get("hyperframes:example") === 8;
}
checks.push({ name: "Pinned Hyperframes registry", ok: registryOk, detail: registryDetail });

const fixtureHtml = [
  join(root, "fixtures", "release-a", "index.html"),
  join(root, "fixtures", "release-a", "compositions", "01-evidence.html"),
  join(root, "fixtures", "release-a", "compositions", "02-compose.html"),
  join(root, "fixtures", "release-a", "compositions", "03-receipt.html"),
];
const unstableIds = fixtureHtml.filter((path) => {
  if (!existsSync(path)) return true;
  const source = readFileSync(path, "utf8");
  return ensureHfIds(source) !== source;
});
checks.push({
  name: "Stable fixture identities",
  ok: unstableIds.length === 0,
  detail:
    unstableIds.length === 0
      ? "all HTML is pre-stamped"
      : unstableIds.map((path) => relative(root, path)).join(", "),
});

for (const path of [
  join(root, "fixtures", "release-a", "assets", "vendor", "gsap.min.js"),
  join(root, "fixtures", "release-a", "assets", "vendor", "gsap-guarded.min.js"),
  join(root, "fixtures", "release-a", "assets", "vendor", "hyperframe.runtime.iife.js"),
  join(root, "data", "projects", "release-a", ".git", "HEAD"),
]) {
  checks.push({
    name: `Bootstrap output: ${relative(root, path)}`,
    ok: existsSync(path),
    detail: existsSync(path) ? "present" : "missing; run `bun run bootstrap`",
  });
}

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name} — ${check.detail}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} required checks passed.`);

if (failed.length > 0) process.exit(1);
