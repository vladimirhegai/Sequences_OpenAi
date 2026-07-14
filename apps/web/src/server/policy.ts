import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JobKind } from "../shared";

const PLAN_PATHS = [
  "STORYBOARD.md",
  "SCRIPT.md",
  "frame.md",
  "story/STORYBOARD.md",
  "story/SCRIPT.md",
  "story/component-plan.json",
  "story/frame.md",
] as const;

const BUILD_PATHS = [
  "index.html",
  "meta.json",
  "hyperframes.json",
  "compositions/**",
  "scenes/**",
  "assets/derived/**",
  "*.motion.json",
] as const;

const FORBIDDEN_NAMES = new Set([
  ".env",
  ".cursorrules",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function assertScopeGrammar(path: string): void {
  if (path.includes("\\") || path.startsWith("/") || path.includes("\0")) {
    throw new Error(`Unsafe project path: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error(`Unsafe project path: ${path}`);
  }
  const stars = [...path].filter((character) => character === "*").length;
  const validWildcard = path.endsWith("/**") || path === "*.motion.json";
  if (stars > 0 && !validWildcard) throw new Error(`Unsupported scope wildcard: ${path}`);
}

function pathMatches(pattern: string, file: string): boolean {
  if (pattern === file) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -2);
    return file.startsWith(prefix) && file.length > prefix.length;
  }
  if (pattern === "*.motion.json") return !file.includes("/") && file.endsWith(".motion.json");
  return false;
}

function scopeIsWithin(candidate: string, outer: string): boolean {
  if (candidate === outer) return true;
  if (outer.endsWith("/**")) {
    const prefix = outer.slice(0, -2);
    return candidate.startsWith(prefix) && !candidate.includes("..");
  }
  if (outer === "*.motion.json") return candidate === outer || pathMatches(outer, candidate);
  return false;
}

export function allowedPaths(kind: JobKind, requested?: readonly string[]): string[] {
  const maximum = kind === "plan" ? [...PLAN_PATHS] : [...BUILD_PATHS];
  if (kind === "revision" && (!requested || requested.length === 0)) {
    throw new Error("Revision jobs require at least one explicit scene, component, or metadata scope path");
  }
  if (!requested || requested.length === 0) return maximum;
  const unique = [...new Set(requested)];
  for (const path of unique) {
    assertScopeGrammar(path);
    if (!maximum.some((outer) => scopeIsWithin(path, outer))) {
      throw new Error(`${path} is outside the allowed ${kind} job scope`);
    }
  }
  return unique.sort();
}

export function assertChangedPaths(changed: readonly string[], allowed: readonly string[]): void {
  if (changed.length === 0) throw new Error("Codex exited without changing any project files");
  for (const file of changed) {
    assertScopeGrammar(file);
    if (FORBIDDEN_NAMES.has(basename(file)) || file.startsWith(".agents/") || file.startsWith(".git/")) {
      throw new Error(`Codex changed a protected file: ${file}`);
    }
    if (!allowed.some((pattern) => pathMatches(pattern, file))) {
      throw new Error(`Codex changed a file outside the approved scope: ${file}`);
    }
  }
}

export async function inspectChangedFiles(candidateRoot: string, changed: readonly string[]): Promise<void> {
  let totalBytes = 0;
  for (const file of changed) {
    const absolute = join(candidateRoot, ...file.split("/"));
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new Error(`Candidate changes must be regular project files: ${file}`);
    }
    if (metadata.isDirectory()) continue;
    if (metadata.size > 10 * 1_024 * 1_024) throw new Error(`Candidate file exceeds 10 MiB: ${file}`);
    totalBytes += metadata.size;
    if (totalBytes > 50 * 1_024 * 1_024) throw new Error("Candidate changes exceed the 50 MiB job limit");
    if (/\.(?:html|css|js|mjs|svg)$/i.test(file)) {
      const source = await readFile(absolute, "utf8");
      const externalAsset = /(?:src|href|url\()\s*[=(]?\s*["']?\s*(?:https?:)?\/\//i.test(source.replace(/xmlns=["'][^"']+["']/gi, ""));
      if (externalAsset) throw new Error(`Generated compositions cannot load external assets: ${file}`);
    }
  }
}

export function assertImagePath(path: string): void {
  assertScopeGrammar(path);
  if (!/\.(?:png|jpe?g|webp)$/i.test(path)) {
    throw new Error(`Codex image inputs must be PNG, JPEG, or WebP project files: ${path}`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
