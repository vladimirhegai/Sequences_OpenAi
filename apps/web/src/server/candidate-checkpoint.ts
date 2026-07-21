import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isWithin, posixPath } from "./files";

const EXCLUDED_ENTRIES = new Set([".git", ".agents", "node_modules"]);
const MAX_FILES = 2_000;
const MAX_BYTES = 128 * 1_024 * 1_024;

interface SavedFile {
  contents: Buffer;
  mode: number;
}

export interface CandidateCheckpoint {
  changedPaths(): Promise<string[]>;
  restore(): Promise<void>;
  restorePaths(paths: readonly string[]): Promise<void>;
}

/**
 * Takes an in-memory transaction checkpoint of creative source. Layout repair
 * turns are small and bounded; this lets the host reject a non-improving turn
 * without resetting or regenerating the candidate worktree.
 */
export async function captureCandidateCheckpoint(root: string): Promise<CandidateCheckpoint> {
  const projectRoot = resolve(root);
  const before = await readFiles(projectRoot);
  return {
    async changedPaths() {
      const after = await readFiles(projectRoot);
      return changedFileNames(before, after);
    },
    async restore() {
      for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
        if (EXCLUDED_ENTRIES.has(entry.name)) continue;
        const target = managedPath(projectRoot, entry.name);
        await rm(target, { recursive: true, force: true });
      }
      for (const [path, saved] of before) {
        const target = managedPath(projectRoot, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, saved.contents);
        await chmod(target, saved.mode);
      }
    },
    async restorePaths(paths) {
      for (const path of paths) {
        const target = managedPath(projectRoot, path);
        await rm(target, { recursive: true, force: true });
        const saved = before.get(path);
        if (!saved) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, saved.contents);
        await chmod(target, saved.mode);
      }
    },
  };
}

async function readFiles(root: string): Promise<Map<string, SavedFile>> {
  const files = new Map<string, SavedFile>();
  let totalBytes = 0;
  await walk(root, async (path) => {
    if (files.size >= MAX_FILES) throw new Error(`Candidate checkpoint exceeds ${MAX_FILES} files`);
    const metadata = await lstat(path);
    if (!metadata.isFile())
      throw new Error(`Candidate checkpoint rejects non-regular file: ${path}`);
    totalBytes += metadata.size;
    if (totalBytes > MAX_BYTES) throw new Error("Candidate checkpoint exceeds 128 MiB");
    const name = posixPath(relative(root, path));
    files.set(name, { contents: await readFile(path), mode: metadata.mode });
  });
  return files;
}

async function walk(directory: string, visit: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (EXCLUDED_ENTRIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Candidate checkpoint rejects symbolic link: ${path}`);
    }
    if (entry.isDirectory()) await walk(path, visit);
    else await visit(path);
  }
}

function changedFileNames(
  before: ReadonlyMap<string, SavedFile>,
  after: ReadonlyMap<string, SavedFile>,
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => {
      const prior = before.get(path);
      const next = after.get(path);
      return !prior || !next || prior.mode !== next.mode || !prior.contents.equals(next.contents);
    })
    .sort();
}

function managedPath(root: string, path: string): string {
  const target = resolve(root, path);
  if (!isWithin(root, target)) throw new Error("Candidate checkpoint path escaped project root");
  return target;
}
