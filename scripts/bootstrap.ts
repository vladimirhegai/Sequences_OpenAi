import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";

const root = resolve(import.meta.dir, "..");
const fixtureDir = join(root, "fixtures", "release-a");
const projectDir = join(root, "data", "projects", "release-a");
const rootAgentsDir = join(root, ".agents");
const projectAgentsDir = join(projectDir, ".agents");

const GENERATED_PROJECT_GITIGNORE = `# Local agent context is pinned by the host bootstrap and never promoted by a model.
.agents/
.hyperframes/
.thumbnails/
renders/
snapshots/
*.log
`;

const runtimeAssets = [
  {
    source: join(root, "node_modules", "gsap", "dist", "gsap.min.js"),
    relativeTarget: join("assets", "vendor", "gsap.min.js"),
  },
  {
    source: join(root, "node_modules", "hyperframes", "dist", "hyperframe.runtime.iife.js"),
    relativeTarget: join("assets", "vendor", "hyperframe.runtime.iife.js"),
  },
] as const;

const fontAssets = [
  ["montserrat", "montserrat-latin-500-normal.woff2"],
  ["montserrat", "montserrat-latin-600-normal.woff2"],
  ["montserrat", "montserrat-latin-700-normal.woff2"],
  ["montserrat", "montserrat-latin-800-normal.woff2"],
  ["montserrat", "montserrat-latin-900-normal.woff2"],
  ["ibm-plex-mono", "ibm-plex-mono-latin-500-normal.woff2"],
  ["ibm-plex-mono", "ibm-plex-mono-latin-600-normal.woff2"],
  ["ibm-plex-mono", "ibm-plex-mono-latin-700-normal.woff2"],
] as const;

function assertWorkspacePath(path: string): void {
  const resolvedPath = resolve(path);
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing to modify a path outside the workspace: ${resolvedPath}`);
  }
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing: ${relative(root, path)}`);
  }
}

function copyPinnedAssets(targetProject: string): void {
  for (const asset of runtimeAssets) {
    requireFile(asset.source, "Pinned runtime asset");
    const target = join(targetProject, asset.relativeTarget);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(asset.source, target);
  }

  for (const [packageName, fileName] of fontAssets) {
    const source = join(root, "node_modules", "@fontsource", packageName, "files", fileName);
    requireFile(source, "Pinned font asset");
    const target = join(targetProject, "assets", "fonts", fileName);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function walkHtmlFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkHtmlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(path);
  }
  return files;
}

function assertFixtureIdsArePinned(): void {
  const unstamped = walkHtmlFiles(fixtureDir).filter((path) => {
    const source = readFileSync(path, "utf8");
    return ensureHfIds(source) !== source;
  });
  if (unstamped.length > 0) {
    throw new Error(
      `Fixture HTML is not canonicalized with stable data-hf-id values: ${unstamped
        .map((path) => relative(root, path))
        .join(", ")}`,
    );
  }
}

function canonicalizeProjectHtml(directory: string): number {
  let changes = 0;
  for (const path of walkHtmlFiles(directory)) {
    const source = readFileSync(path, "utf8");
    const canonical = ensureHfIds(source);
    if (canonical !== source) {
      writeFileSync(path, canonical, "utf8");
      changes += 1;
    }
  }
  return changes;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function replaceDirectory(source: string, destination: string): void {
  assertWorkspacePath(destination);
  const temporary = `${destination}.next-${process.pid}`;
  assertWorkspacePath(temporary);
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(dirname(temporary), { recursive: true });
  cpSync(source, temporary, { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  renameSync(temporary, destination);
}

function syncAgentContext(): boolean {
  const sourceManifest = join(rootAgentsDir, "skills-manifest.json");
  const sourceSkills = join(rootAgentsDir, "skills");
  requireFile(sourceManifest, "Pinned Hyperframes skills manifest");
  if (!existsSync(sourceSkills)) throw new Error("Pinned Hyperframes skills directory is missing");

  const destinationManifest = join(projectAgentsDir, "skills-manifest.json");
  const skillsChanged =
    !existsSync(destinationManifest) || sha256(sourceManifest) !== sha256(destinationManifest);
  if (skillsChanged) {
    replaceDirectory(sourceSkills, join(projectAgentsDir, "skills"));
    mkdirSync(projectAgentsDir, { recursive: true });
    copyFileSync(sourceManifest, destinationManifest);
  }

  const sourceRegistry = join(rootAgentsDir, "registry", "registry.json");
  if (existsSync(sourceRegistry)) {
    const destinationRegistry = join(projectAgentsDir, "registry", "registry.json");
    mkdirSync(dirname(destinationRegistry), { recursive: true });
    if (!existsSync(destinationRegistry) || sha256(sourceRegistry) !== sha256(destinationRegistry)) {
      copyFileSync(sourceRegistry, destinationRegistry);
    }
  }

  return skillsChanged;
}

function runGit(args: string[], cwd: string, allowFailure = false): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

function ensureProjectRepository(): { initialized: boolean; head: string } {
  const gitDir = join(projectDir, ".git");
  const initialized = !existsSync(gitDir);
  if (initialized) {
    runGit(["init", "--initial-branch=main"], projectDir);
    runGit(["config", "user.name", "Sequences Host"], projectDir);
    runGit(["config", "user.email", "sequences@localhost"], projectDir);
    runGit(["add", "--all"], projectDir);
    runGit(["commit", "-m", "chore: initialize accepted Hyperframes project"], projectDir);
  }

  const head = runGit(["rev-parse", "HEAD"], projectDir);
  return { initialized, head };
}

requireFile(join(fixtureDir, "index.html"), "Release A fixture");
copyPinnedAssets(fixtureDir);
assertFixtureIdsArePinned();

const createdProject = !existsSync(projectDir);
if (createdProject) {
  mkdirSync(dirname(projectDir), { recursive: true });
  cpSync(fixtureDir, projectDir, { recursive: true });
}

if (!existsSync(join(projectDir, ".gitignore"))) {
  writeFileSync(join(projectDir, ".gitignore"), GENERATED_PROJECT_GITIGNORE, "utf8");
}

copyPinnedAssets(projectDir);
const canonicalizedFiles = createdProject ? canonicalizeProjectHtml(projectDir) : 0;
const skillsChanged = syncAgentContext();
const repository = ensureProjectRepository();

console.log(
  JSON.stringify(
    {
      ok: true,
      fixture: relative(root, fixtureDir),
      project: relative(root, projectDir),
      createdProject,
      canonicalizedFiles,
      skillsChanged,
      initializedRepository: repository.initialized,
      acceptedHead: repository.head,
    },
    null,
    2,
  ),
);
