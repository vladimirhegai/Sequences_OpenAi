import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { QaReceiptV1, TweenOverlapRemediationV1 } from "../../shared";
import { isWithin } from "../files";
import { pathMatches } from "../policy";

export const TWEEN_OVERLAP_FIXER_VERSION = "sequences.tween-overlap-fixer.v1" as const;

type Repair = TweenOverlapRemediationV1["repaired"][number];

export interface TweenOverlapFixResult {
  repaired: Repair[];
  changedFiles: string[];
  restore(): Promise<void>;
}

interface OverlapTarget {
  selector: string;
  property: string;
  overlapStart: number;
  sourceFiles: string[];
}

/**
 * The pinned lint flags same-target/same-property tweens whose windows touch
 * or overlap — including the classic press/release pair where one tween ends
 * at the exact instant the next begins. Its own fix hint accepts
 * `overwrite: "auto"` on the later tween, which resolves the conflict without
 * changing any authored timing. This fixer applies exactly that remediation
 * to the tween whose position matches the reported overlap start; it never
 * moves, shortens, or removes a tween.
 */
export class TweenOverlapFixer {
  async apply(
    candidateRoot: string,
    qa: QaReceiptV1,
    allowedPaths: readonly string[],
  ): Promise<TweenOverlapFixResult> {
    const targets = collectOverlapTargets(qa);
    const originals = new Map<string, string>();
    const current = new Map<string, string>();
    const repaired: Repair[] = [];
    const compositionFiles = await timelineSourceFiles(candidateRoot);

    for (const target of targets) {
      const candidates =
        target.sourceFiles.length > 0
          ? target.sourceFiles.filter((file) => compositionFiles.includes(file))
          : compositionFiles;
      for (const sourceFile of candidates) {
        if (!allowedPaths.some((pattern) => pathMatches(pattern, sourceFile))) continue;
        const absolute = resolve(candidateRoot, ...sourceFile.split("/"));
        if (!isWithin(candidateRoot, absolute)) continue;
        const metadata = await lstat(absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        const source = current.get(sourceFile) ?? (await readFile(absolute, "utf8"));
        const updated = addOverwriteToLaterTween(source, target);
        if (updated === null) continue;
        if (!originals.has(sourceFile)) originals.set(sourceFile, source);
        current.set(sourceFile, updated);
        await writeFile(absolute, updated, "utf8");
        repaired.push({
          sourceFile,
          selector: target.selector,
          property: target.property,
          at: target.overlapStart,
        });
        break;
      }
    }

    return {
      repaired,
      changedFiles: [...originals.keys()].sort(),
      restore: async () => {
        await Promise.all(
          [...originals].map(([sourceFile, source]) =>
            writeFile(resolve(candidateRoot, ...sourceFile.split("/")), source, "utf8"),
          ),
        );
      },
    };
  }
}

function collectOverlapTargets(qa: QaReceiptV1): OverlapTarget[] {
  const grouped = new Map<string, OverlapTarget>();
  for (const finding of qa.findings) {
    if (finding.code !== "overlapping_gsap_tweens" || finding.severity === "info") continue;
    const parsed =
      /tweens overlap on\s+"([^"]+)"\s+for\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s+between\s+([\d.]+)s/i.exec(
        finding.message,
      );
    if (!parsed) continue;
    const selector = parsed[1]!;
    const property = parsed[2]!.replace(/\s*,\s*/g, ", ");
    const overlapStart = Number(parsed[3]);
    if (!Number.isFinite(overlapStart)) continue;
    const key = `${selector}\0${property}\0${overlapStart.toFixed(3)}`;
    const current = grouped.get(key) ?? { selector, property, overlapStart, sourceFiles: [] };
    if (finding.sourceFile && !current.sourceFiles.includes(finding.sourceFile)) {
      current.sourceFiles.push(finding.sourceFile);
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => left.overlapStart - right.overlapStart);
}

async function timelineSourceFiles(candidateRoot: string): Promise<string[]> {
  const files: string[] = ["index.html"];
  const walk = async (relativeDirectory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(candidateRoot, relativeDirectory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relativePath);
      else if (/\.(?:html?|m?js)$/i.test(entry.name)) files.push(relativePath);
    }
  };
  await walk("compositions");
  await walk("scenes");
  await walk("assets/derived");
  return files;
}

/**
 * Finds the tween call on the reported selector whose numeric position equals
 * the overlap start (the later tween of the conflicting pair) and inserts
 * `overwrite: "auto"` into its vars. Returns null when no unambiguous match
 * exists — a miss is a skipped repair, never a guess.
 */
export function addOverwriteToLaterTween(source: string, target: OverlapTarget): string | null {
  const selectorPattern = new RegExp(
    String.raw`\.(to|from|fromTo)\(\s*(["'])${escapeRegExp(target.selector)}\2\s*,`,
    "g",
  );
  for (let match = selectorPattern.exec(source); match; match = selectorPattern.exec(source)) {
    const method = match[1]!;
    const firstVars = scanObjectLiteral(source, selectorPattern.lastIndex);
    if (!firstVars) continue;
    let vars = firstVars;
    if (method === "fromTo") {
      const separator = /^\s*,\s*/.exec(source.slice(vars.end));
      if (!separator) continue;
      const secondVars = scanObjectLiteral(source, vars.end + separator[0].length);
      if (!secondVars) continue;
      vars = secondVars;
    }
    const tail = /^\s*,\s*([\d.]+)\s*\)/.exec(source.slice(vars.end));
    if (!tail) continue;
    const position = Number(tail[1]);
    if (!Number.isFinite(position) || Math.abs(position - target.overlapStart) > 0.011) continue;
    const body = source.slice(vars.start, vars.end);
    if (/\boverwrite\s*:/.test(body)) return null;
    return `${source.slice(0, vars.start + 1)} overwrite: "auto",${source.slice(vars.start + 1)}`;
  }
  return null;
}

function scanObjectLiteral(
  source: string,
  fromIndex: number,
): { start: number; end: number } | null {
  const opening = /^\s*\{/.exec(source.slice(fromIndex));
  if (!opening) return null;
  const start = fromIndex + opening[0].length - 1;
  let depth = 0;
  let inString: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === inString) inString = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") inString = character;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
