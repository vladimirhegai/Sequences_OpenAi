import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ServerConfig } from "./config";
import { isWithin, sha256 } from "./files";
import { HYPERFRAMES_SKILLS, type SkillCatalogProfile } from "./skill-catalog";

const SkillEntrySchema = z
  .object({
    hash: z.string().regex(/^[0-9a-f]{16}$/),
    files: z.number().int().positive(),
  })
  .strict();

export const SkillsManifestSchema = z
  .object({
    version: z.literal("sequences.skill-profile.v1"),
    profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,119}$/),
    hyperframesVersion: z.literal("0.7.56"),
    source: z.string().min(1).max(300),
    defaultWorkflow: z.string().min(1).max(120),
    requiredSkills: z.array(z.string().min(1).max(120)).min(1).max(20),
    workflows: z.array(z.string().min(1).max(120)).min(1).max(20),
    skills: z.record(z.string().min(1).max(120), SkillEntrySchema),
  })
  .strict();

export type SkillsManifest = z.infer<typeof SkillsManifestSchema>;

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".mjs",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".html",
  ".css",
  ".json",
  ".svg",
  ".csv",
  ".yml",
  ".yaml",
]);

async function regularFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink())
        throw new Error(`Skill bundles cannot contain symlinks: ${absolute}`);
      if (metadata.isDirectory()) await walk(absolute);
      else if (metadata.isFile()) output.push(absolute);
      else throw new Error(`Skill bundles can contain only regular files: ${absolute}`);
    }
  };
  await walk(root);
  return output.sort();
}

export async function hashSkill(root: string): Promise<{ hash: string; files: number }> {
  const files = await regularFiles(root);
  const hash = createHash("sha256");
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    hash.update(rel);
    hash.update("\0");
    const bytes = await readFile(file);
    if (TEXT_EXTENSIONS.has(extname(rel)))
      hash.update(bytes.toString("utf8").replace(/\r\n/g, "\n"));
    else hash.update(bytes);
    hash.update("\0");
  }
  return { hash: hash.digest("hex").slice(0, 16), files: files.length };
}

export class SkillBundle {
  constructor(private readonly config: ServerConfig) {}

  async verifiedManifest(
    root = this.config.skillsRoot,
    manifestPath = this.config.skillsManifestPath,
  ): Promise<{
    manifest: SkillsManifest;
    digest: string;
  }> {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = SkillsManifestSchema.parse(JSON.parse(raw) as unknown);
    const names = Object.keys(manifest.skills).sort();
    if (
      !names.includes(manifest.defaultWorkflow) ||
      !manifest.workflows.includes(manifest.defaultWorkflow)
    ) {
      throw new Error("The default HyperFrames workflow is not installed by its pinned profile");
    }
    for (const required of [...manifest.requiredSkills, ...manifest.workflows]) {
      if (!names.includes(required))
        throw new Error(`Pinned HyperFrames profile skill is missing: ${required}`);
    }
    for (const name of names) {
      const expected = manifest.skills[name]!;
      const skillRoot = join(root, name);
      if (!(await stat(skillRoot)).isDirectory())
        throw new Error(`Pinned Hyperframes skill is missing: ${name}`);
      const actual = await hashSkill(skillRoot);
      if (actual.hash !== expected.hash || actual.files !== expected.files) {
        throw new Error(`Pinned Hyperframes skill failed its manifest hash: ${name}`);
      }
    }
    return { manifest, digest: sha256(JSON.stringify(manifest)) };
  }

  async listSkills(): Promise<SkillCatalogProfile> {
    const { manifest } = await this.verifiedManifest();
    const installed = new Set(Object.keys(manifest.skills));
    return {
      version: manifest.version,
      profileId: manifest.profileId,
      hyperframesVersion: manifest.hyperframesVersion,
      defaultWorkflow: manifest.defaultWorkflow,
      requiredSkills: [...manifest.requiredSkills],
      workflows: [...manifest.workflows],
      skills: [...installed].sort().map(
        (id) =>
          HYPERFRAMES_SKILLS.find((skill) => skill.id === id) ?? {
            id,
            purpose: "Project-local HyperFrames skill.",
          },
      ),
    };
  }

  async readSkill(
    id: string,
    refs: readonly string[] = [],
  ): Promise<Array<{ path: string; content: string }>> {
    const { manifest } = await this.verifiedManifest();
    if (!(id in manifest.skills))
      throw new Error(`HyperFrames skill is not installed in this profile: ${id}`);
    if (refs.length > 11) throw new Error("A skill read can request at most 11 references");
    const requested = ["SKILL.md", ...refs.filter((path) => path !== "SKILL.md")];
    const root = resolve(this.config.skillsRoot, id);
    const output: Array<{ path: string; content: string }> = [];
    let totalBytes = 0;
    for (const requestedPath of requested) {
      if (
        requestedPath.includes("\\") ||
        requestedPath.startsWith("/") ||
        requestedPath.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        throw new Error(`Skill reference is not a safe relative path: ${requestedPath}`);
      }
      const absolute = resolve(root, requestedPath);
      if (!isWithin(root, absolute) || !TEXT_EXTENSIONS.has(extname(absolute).toLowerCase())) {
        throw new Error(`Skill reference is not readable text: ${requestedPath}`);
      }
      const content = await readFile(absolute, "utf8");
      totalBytes += Buffer.byteLength(content, "utf8");
      if (totalBytes > 512 * 1_024)
        throw new Error("Skill read exceeded its 512 KiB context limit");
      output.push({ path: `${id}/${requestedPath}`, content });
    }
    return output;
  }

  async install(candidateRoot: string): Promise<{
    digest: string;
    names: string[];
    requiredSkills: string[];
    catalog: SkillCatalogProfile;
  }> {
    const { manifest, digest } = await this.verifiedManifest();
    const agentsRoot = resolve(candidateRoot, ".agents");
    if (!isWithin(candidateRoot, agentsRoot) || relative(candidateRoot, agentsRoot) !== ".agents") {
      throw new Error("Candidate skill installation escaped the candidate workspace");
    }
    try {
      await stat(agentsRoot);
      throw new Error("Candidate source already contains a protected .agents directory");
    } catch (error) {
      if (error instanceof Error && error.message.includes("already contains")) throw error;
    }
    const target = join(agentsRoot, "skills");
    await mkdir(target, { recursive: true });
    const names = Object.keys(manifest.skills).sort();
    for (const name of names) {
      await copySkillDirectory(join(this.config.skillsRoot, name), join(target, name));
    }
    await writeFile(
      join(agentsRoot, "skills-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    const installed = await this.verifiedManifest(target, join(agentsRoot, "skills-manifest.json"));
    if (installed.digest !== digest)
      throw new Error("Candidate skill bundle changed during installation");
    return {
      digest,
      names,
      requiredSkills: [...manifest.requiredSkills],
      catalog: await this.listSkills(),
    };
  }

  async verifyInstalled(candidateRoot: string, expectedDigest: string): Promise<void> {
    const installed = await this.verifiedManifest(
      join(candidateRoot, ".agents", "skills"),
      join(candidateRoot, ".agents", "skills-manifest.json"),
    );
    if (installed.digest !== expectedDigest)
      throw new Error("Codex changed the protected Hyperframes skill bundle");
  }

  async removeInstalled(candidateRoot: string): Promise<void> {
    const agentsRoot = resolve(candidateRoot, ".agents");
    if (!isWithin(candidateRoot, agentsRoot) || relative(candidateRoot, agentsRoot) !== ".agents") {
      throw new Error("Refusing to remove a skill directory outside the candidate workspace");
    }
    await rm(agentsRoot, { recursive: true, force: false });
  }
}

async function copySkillDirectory(source: string, destination: string): Promise<void> {
  try {
    await stat(destination);
    throw new Error(`Candidate skill target already exists: ${destination}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await mkdir(destination, { recursive: false });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill bundles cannot contain symlinks: ${from}`);
    if (entry.isDirectory()) await copySkillDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Skill bundles can contain only regular files: ${from}`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
