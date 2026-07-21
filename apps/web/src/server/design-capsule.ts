import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DESIGN_CAPSULE_CATALOG,
  DesignCapsuleV1Schema,
  type DesignCapsuleV1,
  type ImageInputV1,
} from "../shared";
import { errorMessage } from "./errors";
import { existingFileWithin } from "./files";
import { elementsWithAttribute, parseHtmlEvidence, type HtmlEvidence } from "./html-evidence";

export const DESIGN_CAPSULE_PATH = "story/design-capsule.json";
export const FRAME_DESIGN_PATH = "frame.md";
const MAX_DESIGN_CAPSULE_BYTES = 128 * 1_024;
const MAX_FRAME_DESIGN_BYTES = 64 * 1_024;

type PaletteRole = keyof DesignCapsuleV1["palette"];

export interface DesignTokenBindingRepair {
  sourceFile: string;
  role: PaletteRole;
  variable: string;
  color: string;
}

export interface DesignTokenBindingFixResult {
  repaired: DesignTokenBindingRepair[];
  changedFiles: string[];
  restore(): Promise<void>;
}

export async function normalizeDesignCapsuleMotionVerbs(projectRoot: string): Promise<number> {
  const path = join(projectRoot, "story", "design-capsule.json");
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_DESIGN_CAPSULE_BYTES) return 0;
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || !("motionVerbs" in raw)) return 0;
    const motionVerbs = (raw as { motionVerbs?: unknown }).motionVerbs;
    if (!Array.isArray(motionVerbs) || motionVerbs.length <= 4) return 0;
    const removed = motionVerbs.length - 4;
    (raw as { motionVerbs: unknown[] }).motionVerbs = motionVerbs.slice(0, 4);
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    return removed;
  } catch {
    return 0;
  }
}

/**
 * Reads only the machine contract. Callers that need to validate dependent
 * artifacts can still use the parsed capsule even when an implementation
 * binding check fails, allowing one repair packet to report every mismatch.
 */
export async function readDesignCapsule(projectRoot: string): Promise<DesignCapsuleV1> {
  const path = join(projectRoot, "story", "design-capsule.json");
  let raw: string;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_DESIGN_CAPSULE_BYTES) {
      throw new Error(`${DESIGN_CAPSULE_PATH} exceeds the 128 KiB design-capsule limit`);
    }
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error))
      throw new Error(`The director did not author the required ${DESIGN_CAPSULE_PATH}`);
    throw error;
  }

  try {
    return DesignCapsuleV1Schema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`${DESIGN_CAPSULE_PATH} is invalid: ${errorMessage(error)}`);
  }
}

export async function assertDesignCapsule(
  projectRoot: string,
  expectedImages?: readonly ImageInputV1[],
): Promise<DesignCapsuleV1> {
  const capsule = await assertDesignCapsuleDirection(projectRoot, expectedImages);

  const htmlFiles: HtmlEvidence[] = [];
  for (const implementationFile of capsule.implementationFiles) {
    if (!/^(?:index\.html|(?:compositions|scenes)\/.+\.html?)$/i.test(implementationFile)) {
      throw new Error(`${DESIGN_CAPSULE_PATH} must bind only to composition HTML`);
    }
    const source = await readFile(
      await existingFileWithin(projectRoot, implementationFile),
      "utf8",
    );
    htmlFiles.push(parseHtmlEvidence(implementationFile, source));
  }
  const rootMatches = elementsWithAttribute(htmlFiles, "data-hf-id", capsule.rootHfId);
  if (rootMatches.length !== 1) {
    throw new Error(
      `${DESIGN_CAPSULE_PATH} root ${capsule.rootHfId} must bind to exactly one data-hf-id (found ${rootMatches.length})`,
    );
  }
  const rootFile = rootMatches[0]!.file;
  if (!rootFile.styleText.trim()) {
    throw new Error(
      `${DESIGN_CAPSULE_PATH} root file ${rootFile.path} must contain authored CSS in a style element`,
    );
  }

  const tokenFailures: string[] = [];
  for (const [role, variable] of tokenBindingEntries(capsule)) {
    const color = capsule.palette[role];
    const declaration = tokenDeclarationPattern(variable, color);
    if (!declaration.test(rootFile.styleText)) {
      tokenFailures.push(
        `${DESIGN_CAPSULE_PATH} ${role} token ${variable} is not declared as ${color}`,
      );
    }
  }
  if (tokenFailures.length > 0) {
    throw new Error(
      tokenFailures.length === 1
        ? tokenFailures[0]
        : `${DESIGN_CAPSULE_PATH} has ${tokenFailures.length} palette binding mismatches:\n${tokenFailures
            .map((failure, index) => `${index + 1}. ${failure}`)
            .join("\n")}`,
    );
  }

  const authoredRules = rootFile.styleText.replace(/@font-face\s*\{[^{}]*\}/gi, "");
  for (const [role, type] of Object.entries(capsule.typography)) {
    const familyUse = new RegExp(
      `(?:font-family|font)\\s*:\\s*[^;}]*["']?${escapeRegExp(type.family)}(?:["']|\\b)`,
      "i",
    );
    if (!familyUse.test(authoredRules)) {
      throw new Error(
        `${DESIGN_CAPSULE_PATH} ${role} family ${type.family} is not used in root file ${rootFile.path}`,
      );
    }
  }
  await assertFrameDesign(projectRoot, capsule);
  return capsule;
}

/**
 * Validates the complete design direction that must be safe to lock before a
 * balanced-workflow compositor starts. Runtime HTML bindings are intentionally
 * deferred to assertDesignCapsule(), but origin custody and objective palette
 * contrast belong to the creative director and cannot be repaired later by a
 * compositor whose stage excludes the locked preproduction artifacts.
 */
export async function assertDesignCapsuleDirection(
  projectRoot: string,
  expectedImages?: readonly Pick<ImageInputV1, "path">[],
): Promise<DesignCapsuleV1> {
  const capsule = await readDesignCapsule(projectRoot);

  if (capsule.origin.kind === "catalog") {
    const catalog = DESIGN_CAPSULE_CATALOG[capsule.origin.catalogId];
    for (const field of [
      "basis",
      "palette",
      "typography",
      "geometry",
      "density",
      "compositionDialect",
    ] as const) {
      if (stableJson(capsule[field]) !== stableJson(catalog[field])) {
        throw new Error(
          `${DESIGN_CAPSULE_PATH} must preserve catalog ${capsule.origin.catalogId} ${field}`,
        );
      }
    }
  }

  if (expectedImages !== undefined && expectedImages.length > 0) {
    if (capsule.origin.kind !== "reference-derived") {
      throw new Error(
        `${DESIGN_CAPSULE_PATH} must use reference-derived origin with reference-locked fidelity when host-supplied images exist`,
      );
    }
    const expected = expectedImages.map((image) => image.path);
    if (JSON.stringify(capsule.origin.imagePaths) !== JSON.stringify(expected)) {
      throw new Error(
        `${DESIGN_CAPSULE_PATH} must bind reference-derived direction to every supplied image in host order`,
      );
    }
  } else if (capsule.origin.kind === "reference-derived" && expectedImages !== undefined) {
    throw new Error(
      `${DESIGN_CAPSULE_PATH} cannot claim reference-derived origin without host-supplied images`,
    );
  }

  assertPaletteContrast(capsule);
  return capsule;
}

/**
 * Repairs only the mechanically provable form of an unused design binding:
 * the bound root stylesheet already contains the exact palette literal in a
 * real color-bearing declaration. One such literal is replaced with the
 * declared custom property. Missing declarations, approximate colors, and
 * tokens with no exact authored use are deliberately left for the director;
 * choosing a new visual role would be a creative edit, not deterministic QA.
 */
export async function repairUnusedDesignTokenBindings(
  projectRoot: string,
): Promise<DesignTokenBindingFixResult> {
  const capsule = await readDesignCapsule(projectRoot);
  const htmlFiles: HtmlEvidence[] = [];
  const absoluteByFile = new Map<string, string>();
  for (const implementationFile of capsule.implementationFiles) {
    if (!/^(?:index\.html|(?:compositions|scenes)\/.+\.html?)$/i.test(implementationFile)) {
      return emptyDesignTokenFixResult();
    }
    const absolute = await existingFileWithin(projectRoot, implementationFile);
    const source = await readFile(absolute, "utf8");
    htmlFiles.push(parseHtmlEvidence(implementationFile, source));
    absoluteByFile.set(implementationFile, absolute);
  }

  const rootMatches = elementsWithAttribute(htmlFiles, "data-hf-id", capsule.rootHfId);
  if (rootMatches.length !== 1) return emptyDesignTokenFixResult();
  const rootFile = rootMatches[0]!.file;
  const absolute = absoluteByFile.get(rootFile.path);
  if (!absolute || !rootFile.styleText.trim()) return emptyDesignTokenFixResult();

  const original = await readFile(absolute, "utf8");
  let source = original;
  const repaired: DesignTokenBindingRepair[] = [];
  for (const [role, variable] of tokenBindingEntries(capsule)) {
    const color = capsule.palette[role];
    const currentStyle = parseHtmlEvidence(rootFile.path, source).styleText;
    if (!tokenDeclarationPattern(variable, color).test(currentStyle)) continue;
    if (tokenUsePattern(variable).test(currentStyle)) continue;
    const updated = replaceOnePaletteLiteralInStyle(source, role, variable, color);
    if (updated === null) continue;

    const updatedStyle = parseHtmlEvidence(rootFile.path, updated).styleText;
    if (
      !tokenDeclarationPattern(variable, color).test(updatedStyle) ||
      !tokenUsePattern(variable).test(updatedStyle)
    ) {
      continue;
    }
    source = updated;
    repaired.push({ sourceFile: rootFile.path, role, variable, color });
  }

  if (source === original) return emptyDesignTokenFixResult();
  await writeFile(absolute, source, "utf8");
  return {
    repaired,
    changedFiles: [rootFile.path],
    restore: async () => writeFile(absolute, original, "utf8"),
  };
}

function emptyDesignTokenFixResult(): DesignTokenBindingFixResult {
  return { repaired: [], changedFiles: [], restore: async () => undefined };
}

function tokenBindingEntries(capsule: DesignCapsuleV1): Array<[PaletteRole, string]> {
  return Object.entries(capsule.tokenBindings) as Array<[PaletteRole, string]>;
}

function tokenDeclarationPattern(variable: string, color: string): RegExp {
  return new RegExp(`${escapeRegExp(variable)}\\s*:\\s*${escapeRegExp(color)}(?=\\s*[;}])`, "i");
}

function tokenUsePattern(variable: string): RegExp {
  // A lookahead accepts valid fallback forms such as var(--surface, #fff)
  // while still rejecting lookalike names such as --surface-muted.
  return new RegExp(`var\\(\\s*${escapeRegExp(variable)}(?=\\s*[,\\)])`, "i");
}

function replaceOnePaletteLiteralInStyle(
  source: string,
  role: PaletteRole,
  variable: string,
  color: string,
): string | null {
  const stylePattern = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  for (let style = stylePattern.exec(source); style; style = stylePattern.exec(source)) {
    const body = style[1] ?? "";
    const replacement = replaceOneColorDeclarationLiteral(body, role, variable, color);
    if (replacement === null) continue;
    const bodyStart = (style.index ?? 0) + style[0].indexOf(body);
    return `${source.slice(0, bodyStart)}${replacement}${source.slice(bodyStart + body.length)}`;
  }
  return null;
}

function replaceOneColorDeclarationLiteral(
  style: string,
  role: PaletteRole,
  variable: string,
  color: string,
): string | null {
  // Preserve offsets while excluding comments from both declaration and color
  // matching. This also guarantees a commented literal cannot trigger a fix.
  const searchable = style.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));
  const declaration = /(?:^|[;{])\s*([a-z_-][\w-]*)\s*:\s*([^;{}]*)/gim;
  const colorPattern = new RegExp(`${escapeRegExp(color)}(?![0-9a-f])`, "i");
  for (let match = declaration.exec(searchable); match; match = declaration.exec(searchable)) {
    const property = match[1]!.toLowerCase();
    if (property.startsWith("--") || property === variable.toLowerCase()) continue;
    if (!isCompatiblePaletteProperty(role, property)) continue;
    const value = match[2]!;
    const colorMatch = colorPattern.exec(value);
    if (!colorMatch) continue;
    const valueStart = (match.index ?? 0) + match[0].length - value.length;
    const colorStart = valueStart + (colorMatch.index ?? 0);
    return `${style.slice(0, colorStart)}var(${variable})${style.slice(colorStart + colorMatch[0].length)}`;
  }
  return null;
}

function isCompatiblePaletteProperty(role: PaletteRole, property: string): boolean {
  if (role === "background" || role === "surface") {
    return /^(?:background|background-color)$/.test(property);
  }
  if (role === "text" || role === "muted" || role === "accentText") {
    return /^(?:color|fill|stroke|caret-color|text-decoration-color)$/.test(property);
  }
  if (role === "border") {
    return /^(?:border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|column-rule(?:-color)?)$/.test(
      property,
    );
  }
  return /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|caret-color|text-decoration-color|accent-color)$/.test(
    property,
  );
}

async function assertFrameDesign(projectRoot: string, capsule: DesignCapsuleV1): Promise<void> {
  const path = join(projectRoot, FRAME_DESIGN_PATH);
  let frame: string;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_FRAME_DESIGN_BYTES) {
      throw new Error(`${FRAME_DESIGN_PATH} exceeds the 64 KiB design-spec limit`);
    }
    frame = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error))
      throw new Error(`The director did not author the required ${FRAME_DESIGN_PATH}`);
    throw error;
  }

  const frontmatter = new RegExp(
    `^---\\r?\\nversion: sequences\\.frame\\.v1\\r?\\ncapsule: ${escapeRegExp(capsule.id)}\\r?\\n---(?:\\r?\\n|$)`,
  );
  if (!frontmatter.test(frame)) {
    throw new Error(
      `${FRAME_DESIGN_PATH} must identify sequences.frame.v1 and capsule ${capsule.id} in its opening frontmatter`,
    );
  }

  const lowerFrame = frame.toLowerCase();
  for (const [role, color] of Object.entries(capsule.palette)) {
    if (!lowerFrame.includes(color.toLowerCase())) {
      throw new Error(`${FRAME_DESIGN_PATH} must document ${role} color ${color}`);
    }
  }
  for (const [role, type] of Object.entries(capsule.typography)) {
    if (!frame.includes(type.family)) {
      throw new Error(`${FRAME_DESIGN_PATH} must document ${role} family ${type.family}`);
    }
  }
}

function assertPaletteContrast(capsule: DesignCapsuleV1): void {
  const pairs: Array<[string, string, number, string]> = [
    [capsule.palette.text, capsule.palette.background, 4.5, "text/background"],
    [capsule.palette.text, capsule.palette.surface, 4.5, "text/surface"],
    [capsule.palette.muted, capsule.palette.background, 4.5, "muted/background"],
    [capsule.palette.muted, capsule.palette.surface, 4.5, "muted/surface"],
    [capsule.palette.accentText, capsule.palette.accent, 4.5, "accentText/accent"],
  ];
  for (const [foreground, background, required, label] of pairs) {
    const ratio = contrastRatio(foreground, background);
    if (ratio + 0.001 < required) {
      throw new Error(
        `${DESIGN_CAPSULE_PATH} palette ${label} contrast ${ratio.toFixed(2)} is below ${required.toFixed(1)}:1`,
      );
    }
  }
}

function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
