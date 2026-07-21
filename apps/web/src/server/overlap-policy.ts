import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { OverlapIntentV1, SequenceArtifactV1 } from "../shared";
import { posixPath } from "./files";

const SUPPRESSION_ATTRIBUTE =
  /\sdata-layout-allow-(?:overlap|occlusion)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi;
const START_TAG = /<([a-z][\w:-]*)([^<>]*?)>/gi;

export interface OverlapSuppressionMarker {
  sourceFile: string;
  tag: string;
  identity: string | null;
  intentId: string | null;
  marker: "overlap" | "occlusion";
  broad: boolean;
}

export interface OverlapPolicyViolation {
  sourceFile: string;
  identity: string | null;
  intentId: string | null;
  code:
    | "overlap_marker_missing_identity"
    | "overlap_marker_missing_intent"
    | "overlap_marker_unknown_intent"
    | "overlap_marker_entity_mismatch"
    | "overlap_marker_broad_suppression";
  message: string;
}

export interface OverlapPolicyScan {
  markers: OverlapSuppressionMarker[];
  violations: OverlapPolicyViolation[];
}

/**
 * Validates authored escape hatches against the semantic overlap contract.
 * HyperFrames inherits these attributes through `closest()`, so Sequences
 * treats an unbound or broad marker as QA suppression rather than intent.
 */
export async function scanOverlapPolicy(
  projectRoot: string,
  sequence: SequenceArtifactV1,
): Promise<OverlapPolicyScan> {
  const intents = new Map(sequence.overlapIntents.map((intent) => [intent.id, intent]));
  const markers: OverlapSuppressionMarker[] = [];
  const violations: OverlapPolicyViolation[] = [];

  for (const file of await htmlFiles(projectRoot)) {
    const sourceFile = posixPath(relative(projectRoot, file));
    const html = await readFile(file, "utf8");
    for (const match of html.matchAll(START_TAG)) {
      const attributes = match[2] ?? "";
      const overlap = hasAttribute(attributes, "data-layout-allow-overlap");
      const occlusion = hasAttribute(attributes, "data-layout-allow-occlusion");
      if (!overlap && !occlusion) continue;
      const identity = attribute(attributes, "data-hf-id") ?? attribute(attributes, "id");
      const intentId = attribute(attributes, "data-layout-intent");
      const classes = new Set((attribute(attributes, "class") ?? "").split(/\s+/).filter(Boolean));
      const broad =
        ["html", "body", "main"].includes(match[1]!.toLowerCase()) ||
        identity === "root" ||
        identity === "app" ||
        Boolean(identity?.endsWith("-root")) ||
        classes.has("scene") ||
        classes.has("root") ||
        classes.has("clip") ||
        classes.has("composition") ||
        hasAttribute(attributes, "data-composition-id") ||
        hasAttribute(attributes, "data-composition-src");

      for (const marker of [
        ...(overlap ? (["overlap"] as const) : []),
        ...(occlusion ? (["occlusion"] as const) : []),
      ]) {
        markers.push({ sourceFile, tag: match[1]!, identity, intentId, marker, broad });
      }

      const violation = markerViolation(sourceFile, identity, intentId, broad, intents);
      if (violation) violations.push(violation);
    }
  }

  return { markers, violations: uniqueViolations(violations) };
}

/**
 * Removes only overlap/occlusion escape hatches from the disposable QA copy.
 * Pixels are unchanged, while the host retains an unsuppressed detector pass
 * that can be adjudicated against exact intent after inspection.
 */
export async function stripOverlapSuppressionMarkers(projectRoot: string): Promise<number> {
  let stripped = 0;
  for (const file of await htmlFiles(projectRoot)) {
    const source = await readFile(file, "utf8");
    const next = source.replace(SUPPRESSION_ATTRIBUTE, () => {
      stripped += 1;
      return "";
    });
    if (next !== source) await writeFile(file, next, "utf8");
  }
  return stripped;
}

function markerViolation(
  sourceFile: string,
  identity: string | null,
  intentId: string | null,
  broad: boolean,
  intents: ReadonlyMap<string, OverlapIntentV1>,
): OverlapPolicyViolation | null {
  if (!identity) {
    return {
      sourceFile,
      identity,
      intentId,
      code: "overlap_marker_missing_identity",
      message: "Overlap/occlusion markers require an exact id or data-hf-id.",
    };
  }
  if (broad) {
    return {
      sourceFile,
      identity,
      intentId,
      code: "overlap_marker_broad_suppression",
      message: `Marker on ${identity} suppresses a root, scene, composition mount, or multi-part container.`,
    };
  }
  if (!intentId) {
    return {
      sourceFile,
      identity,
      intentId,
      code: "overlap_marker_missing_intent",
      message: `Marker on ${identity} must name its exact data-layout-intent.`,
    };
  }
  const intent = intents.get(intentId);
  if (!intent) {
    return {
      sourceFile,
      identity,
      intentId,
      code: "overlap_marker_unknown_intent",
      message: `Marker on ${identity} references unknown overlap intent ${intentId}.`,
    };
  }
  if (!intent.entities.includes(identity)) {
    return {
      sourceFile,
      identity,
      intentId,
      code: "overlap_marker_entity_mismatch",
      message: `Marker identity ${identity} is not an entity in overlap intent ${intentId}.`,
    };
  }
  return null;
}

function attribute(source: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(source);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function hasAttribute(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s*=|\\s|$)`, "i").test(source);
}

async function htmlFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  await walk(root, output, 0);
  return output.sort();
}

async function walk(directory: string, output: string[], depth: number): Promise<void> {
  if (depth > 3) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", ".agents", "node_modules", "snapshots"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output, depth + 1);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) output.push(path);
  }
}

function uniqueViolations(values: readonly OverlapPolicyViolation[]): OverlapPolicyViolation[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.sourceFile}\0${value.code}\0${value.identity ?? ""}\0${value.intentId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
