import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ApiProblem } from "./errors";

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function managedPath(root: string, ...segments: string[]): string {
  const candidate = resolve(root, ...segments);
  if (candidate === resolve(root) || !isWithin(root, candidate)) {
    throw new ApiProblem(400, "unsafe_path", "The resolved path is outside its managed root");
  }
  return candidate;
}

export async function existingFileWithin(root: string, requestedPath: string): Promise<string> {
  const lexical = managedPath(root, requestedPath);
  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(lexical)]);
  } catch {
    throw new ApiProblem(404, "file_not_found", "The requested project file does not exist");
  }
  if (!isWithin(canonicalRoot, canonicalFile) || canonicalRoot === canonicalFile) {
    throw new ApiProblem(403, "unsafe_path", "Project symlink traversal is not allowed");
  }
  const stat = await lstat(canonicalFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ApiProblem(404, "file_not_found", "The requested project path is not a regular file");
  }
  return canonicalFile;
}

export async function atomicWriteJson<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  value: z.input<T>,
): Promise<z.output<T>> {
  const parsed = schema.parse(value);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return parsed;
}

export async function readJson<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.output<T>> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return schema.parse(parsed);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function posixPath(value: string): string {
  return value.split(sep).join("/");
}
