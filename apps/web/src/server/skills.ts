import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ServerConfig } from "./config";
import { isWithin, sha256 } from "./files";

const SkillEntrySchema = z
  .object({
    hash: z.string().regex(/^[0-9a-f]{16}$/),
    files: z.number().int().positive(),
  })
  .strict();

export const SkillsManifestSchema = z
  .object({
    source: z.string().min(1).max(300),
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
      if (metadata.isSymbolicLink()) throw new Error(`Skill bundles cannot contain symlinks: ${absolute}`);
      if (metadata.isDirectory()) await walk(absolute);
      else if (metadata.isFile()) output.push(absolute);
      else throw new Error(`Skill bundles can contain only regular files: ${absolute}`);
    }
  };
  await walk(root);
  return output.sort();
}

async function hashSkill(root: string): Promise<{ hash: string; files: number }> {
  const files = await regularFiles(root);
  const hash = createHash("sha256");
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    hash.update(rel);
    hash.update("\0");
    const bytes = await readFile(file);
    if (TEXT_EXTENSIONS.has(extname(rel))) hash.update(bytes.toString("utf8").replace(/\r\n/g, "\n"));
    else hash.update(bytes);
    hash.update("\0");
  }
  return { hash: hash.digest("hex").slice(0, 16), files: files.length };
}

export class SkillBundle {
  constructor(private readonly config: ServerConfig) {}

  async verifiedManifest(root = this.config.skillsRoot): Promise<{
    manifest: SkillsManifest;
    digest: string;
  }> {
    const raw = await readFile(this.config.skillsManifestPath, "utf8");
    const manifest = SkillsManifestSchema.parse(JSON.parse(raw) as unknown);
    const names = Object.keys(manifest.skills).sort();
    if (names.length !== 8) {
      throw new Error(`The pinned Hyperframes manifest must contain exactly 8 skills; found ${names.length}`);
    }
    for (const name of names) {
      const expected = manifest.skills[name]!;
      const skillRoot = join(root, name);
      if (!(await stat(skillRoot)).isDirectory()) throw new Error(`Pinned Hyperframes skill is missing: ${name}`);
      const actual = await hashSkill(skillRoot);
      if (actual.hash !== expected.hash || actual.files !== expected.files) {
        throw new Error(`Pinned Hyperframes skill failed its manifest hash: ${name}`);
      }
    }
    const signature = names
      .map((name) => `${name}:${manifest.skills[name]!.hash}:${manifest.skills[name]!.files}`)
      .join("\n");
    return { manifest, digest: sha256(signature) };
  }

  async install(candidateRoot: string): Promise<{ digest: string; names: string[] }> {
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
      await cp(join(this.config.skillsRoot, name), join(target, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    await writeFile(join(agentsRoot, "skills-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const installed = await this.verifiedManifest(target);
    if (installed.digest !== digest) throw new Error("Candidate skill bundle changed during installation");
    return { digest, names };
  }

  async verifyInstalled(candidateRoot: string, expectedDigest: string): Promise<void> {
    const installed = await this.verifiedManifest(join(candidateRoot, ".agents", "skills"));
    if (installed.digest !== expectedDigest) throw new Error("Codex changed the protected Hyperframes skill bundle");
  }

  async removeInstalled(candidateRoot: string): Promise<void> {
    const agentsRoot = resolve(candidateRoot, ".agents");
    if (!isWithin(candidateRoot, agentsRoot) || relative(candidateRoot, agentsRoot) !== ".agents") {
      throw new Error("Refusing to remove a skill directory outside the candidate workspace");
    }
    await rm(agentsRoot, { recursive: true, force: false });
  }
}
