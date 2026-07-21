import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ContrastRemediationV1, QaReceiptV1 } from "../../shared";
import { isWithin, sha256 } from "../files";
import { pathMatches } from "../policy";

export const CONTRAST_FIXER_VERSION = "sequences.contrast-fixer.v1" as const;
const CONTRAST_MARGIN = 0.08;
const STYLE_PATTERN =
  /\n?\s*<style\b[^>]*\bdata-sequences-qa-fixer\s*=\s*(["'])contrast-v1\1[^>]*>([\s\S]*?)<\/style>/gi;

type Repair = ContrastRemediationV1["repaired"][number];

export interface ContrastFixResult {
  repaired: Repair[];
  changedFiles: string[];
  restore(): Promise<void>;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Oklab {
  l: number;
  a: number;
  b: number;
}

interface ContrastTarget {
  sourceFile: string;
  selector: string;
  text: string | null;
  foregrounds: Rgb[];
  backgrounds: Rgb[];
  requiredRatio: number;
}

export class ContrastFixer {
  /**
   * `priorRepairs` carries every background this run has already had to
   * satisfy for a selector. An element that crossfades over two backgrounds
   * may be sampled against only one of them per QA attempt; without the
   * union, pass 2 "fixes" the color for the newly sampled background and
   * silently re-breaks the one pass 1 fixed, oscillating until the budget
   * runs out (observed live on run_34c0fb68).
   */
  async apply(
    candidateRoot: string,
    qa: QaReceiptV1,
    allowedPaths: readonly string[],
    priorRepairs: readonly Repair[] = [],
  ): Promise<ContrastFixResult> {
    const targets = collectTargets(qa).filter((target) =>
      allowedPaths.some((pattern) => pathMatches(pattern, target.sourceFile)),
    );
    const originals = new Map<string, string>();
    const repaired: Repair[] = [];
    const byFile = new Map<string, ContrastTarget[]>();
    for (const target of targets) {
      const entries = byFile.get(target.sourceFile) ?? [];
      entries.push(target);
      byFile.set(target.sourceFile, entries);
    }

    for (const [sourceFile, fileTargets] of byFile) {
      const absolute = resolve(candidateRoot, ...sourceFile.split("/"));
      if (!isWithin(candidateRoot, absolute) || !/\.html$/i.test(sourceFile)) continue;
      const metadata = await lstat(absolute);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      const original = await readFile(absolute, "utf8");
      let source = original;
      const entries: Array<{ rule: string; repair: Repair }> = [];
      for (const target of fileTargets) {
        const localized = localizeSelector(source, target);
        source = localized.source;
        const selector = safeRepairSelector(localized.selector);
        if (!selector) continue;
        for (const prior of priorRepairs) {
          if (prior.sourceFile !== target.sourceFile) continue;
          if (prior.selector !== selector && prior.selector !== target.selector) continue;
          for (const backgroundCss of prior.backgroundColors) {
            const background = parseColor(backgroundCss);
            if (background) pushUniqueColor(target.backgrounds, background);
          }
          target.requiredRatio = Math.max(target.requiredRatio, prior.requiredRatio);
        }
        const selection = selectAccessibleForeground(
          target.foregrounds[0]!,
          target.backgrounds,
          target.requiredRatio,
        );
        const plate = selection
          ? null
          : selectAccessiblePlate(
              target.foregrounds[0]!,
              target.backgrounds[0]!,
              target.requiredRatio,
            );
        if (!selection && !plate) continue;
        const foreground = selection ?? plate!.foreground;
        const plateColor = plate?.background ?? null;
        const marker = sha256(`${target.sourceFile}\0${selector}`).slice(0, 16);
        const color = rgbCss(foreground);
        const declaration = plateColor
          ? [
              `color:${color} !important`,
              `background-color:${rgbCss(plateColor)} !important`,
              `box-shadow:0 0 0 .16em ${rgbCss(plateColor)} !important`,
              "border-radius:.18em",
              "box-decoration-break:clone",
              "-webkit-box-decoration-break:clone",
            ].join(";")
          : `color:${color} !important`;
        entries.push({
          rule: `/* hf-contrast:${marker} */\n${selector}{${declaration};}`,
          repair: {
            sourceFile: target.sourceFile,
            selector,
            strategy: plateColor ? "contrast_plate" : "foreground",
            foregroundBefore: rgbCss(target.foregrounds[0]!),
            foregroundAfter: color,
            plateColor: plateColor ? rgbCss(plateColor) : null,
            backgroundColors: target.backgrounds.map(rgbCss),
            requiredRatio: target.requiredRatio,
          },
        });
      }
      const existingBodies = [...source.matchAll(STYLE_PATTERN)]
        .map((match) => match[2]?.trim() ?? "")
        .filter(Boolean);
      const additions = [
        ...new Set(
          entries
            .filter((entry) => !existingBodies.some((body) => body.includes(entry.rule)))
            .map((entry) => entry.rule),
        ),
      ];
      if (additions.length === 0) continue;
      const body = [...existingBodies, ...additions].filter(Boolean).join("\n");
      const style = `<style data-sequences-qa-fixer="contrast-v1">\n${body}\n</style>`;
      const withoutExisting = source.replace(STYLE_PATTERN, "");
      const updated = injectStyle(withoutExisting, style);
      originals.set(sourceFile, original);
      await writeFile(absolute, updated, "utf8");
      const addedMarkers = new Set(
        additions.map((rule) => rule.match(/hf-contrast:([0-9a-f]+)/)?.[1]),
      );
      const recordedMarkers = new Set<string>();
      repaired.push(
        ...entries
          .filter((entry) => {
            const marker = entry.rule.match(/hf-contrast:([0-9a-f]+)/)?.[1];
            if (marker === undefined || !addedMarkers.has(marker) || recordedMarkers.has(marker)) {
              return false;
            }
            recordedMarkers.add(marker);
            return true;
          })
          .map((entry) => entry.repair),
      );
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

export function contrastRatio(foreground: string, background: string): number {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) throw new Error("contrastRatio expects opaque rgb() or hex colors");
  return ratio(fg, bg);
}

export function accessibleBrandColor(
  foreground: string,
  backgrounds: readonly string[],
  requiredRatio: number,
): string | null {
  const fg = parseColor(foreground);
  const bg = backgrounds.map(parseColor);
  if (!fg || bg.some((value) => !value)) return null;
  const selected = selectAccessibleForeground(fg, bg as Rgb[], requiredRatio);
  return selected ? rgbCss(selected) : null;
}

function collectTargets(qa: QaReceiptV1): ContrastTarget[] {
  const grouped = new Map<string, ContrastTarget>();
  for (const finding of qa.findings) {
    if (
      finding.category !== "contrast" ||
      finding.severity === "info" ||
      !finding.sourceFile ||
      !finding.selector ||
      !finding.contrast
    ) {
      continue;
    }
    const selector = finding.identity?.hfId
      ? `[data-hf-id="${cssAttributeValue(finding.identity.hfId)}"]`
      : finding.selector;
    const key = `${finding.sourceFile}\0${selector}`;
    const current = grouped.get(key) ?? {
      sourceFile: finding.sourceFile,
      selector,
      text: finding.text ?? null,
      foregrounds: [],
      backgrounds: [],
      requiredRatio: 0,
    };
    for (const sample of finding.contrast.samples) {
      const foreground = parseColor(sample.foreground);
      const background = parseColor(sample.background);
      if (!foreground || !background) continue;
      pushUniqueColor(current.foregrounds, foreground);
      pushUniqueColor(current.backgrounds, background);
      current.requiredRatio = Math.max(current.requiredRatio, sample.requiredRatio);
    }
    if (current.foregrounds.length > 0 && current.backgrounds.length > 0) grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) =>
    `${left.sourceFile}:${left.selector}`.localeCompare(`${right.sourceFile}:${right.selector}`),
  );
}

function selectAccessibleForeground(
  foreground: Rgb,
  backgrounds: readonly Rgb[],
  requiredRatio: number,
): Rgb | null {
  const target = requiredRatio + CONTRAST_MARGIN;
  if (backgrounds.every((background) => ratio(foreground, background) >= target)) return foreground;
  const original = rgbToOklab(foreground);
  let best: { rgb: Rgb; distance: number } | null = null;
  for (let chromaStep = 0; chromaStep <= 20; chromaStep += 1) {
    const chromaScale = 1 - chromaStep / 20;
    for (let lightStep = 0; lightStep <= 1_000; lightStep += 1) {
      const candidateLab = {
        l: lightStep / 1_000,
        a: original.a * chromaScale,
        b: original.b * chromaScale,
      };
      const candidate = oklabToRgb(candidateLab);
      if (
        !candidate ||
        !backgrounds.every((background) => ratio(candidate, background) >= target)
      ) {
        continue;
      }
      const distance = oklabDistance(original, candidateLab);
      if (!best || distance < best.distance) best = { rgb: candidate, distance };
    }
  }
  return best?.rgb ?? null;
}

function selectAccessiblePlate(
  foreground: Rgb,
  background: Rgb,
  requiredRatio: number,
): { foreground: Rgb; background: Rgb } | null {
  const foregroundCandidates = [foreground, { r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }];
  let best: { foreground: Rgb; background: Rgb; distance: number } | null = null;
  const backgroundLab = rgbToOklab(background);
  for (const text of foregroundCandidates) {
    for (let lightStep = 0; lightStep <= 1_000; lightStep += 1) {
      const plateLab = { ...backgroundLab, l: lightStep / 1_000 };
      const plate = oklabToRgb(plateLab);
      if (!plate || ratio(text, plate) < requiredRatio + CONTRAST_MARGIN) continue;
      const distance =
        oklabDistance(backgroundLab, plateLab) +
        oklabDistance(rgbToOklab(foreground), rgbToOklab(text));
      if (!best || distance < best.distance)
        best = { foreground: text, background: plate, distance };
    }
  }
  return best && { foreground: best.foreground, background: best.background };
}

function localizeSelector(
  source: string,
  target: ContrastTarget,
): { source: string; selector: string } {
  if (!target.text || /^\[data-hf-id=/.test(target.selector)) {
    return { source, selector: target.selector };
  }
  const terminal = /([a-z][\w-]*)(?::nth-(?:of-)?type\([1-9]\d*\))?\s*$/i.exec(target.selector);
  if (!terminal) return { source, selector: target.selector };
  const tag = terminal[1]!.toLowerCase();
  const expectedText = normalizeText(target.text);
  const elementPattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
  const matches = [...source.matchAll(elementPattern)].filter(
    (match) => normalizeText(match[2] ?? "") === expectedText,
  );
  if (matches.length === 0) return { source, selector: target.selector };

  const marker = `contrast-${sha256(`${target.sourceFile}\0${tag}\0${expectedText}`).slice(0, 16)}`;
  const selector = `[data-sequences-contrast-id="${marker}"]`;
  let updated = source;
  const insertionOffsets: number[] = [];
  for (const match of matches) {
    const matchStart = match.index ?? -1;
    const openingEnd = match[0].indexOf(">");
    if (matchStart < 0 || openingEnd < 0) continue;
    const opening = match[0].slice(0, openingEnd + 1);
    const existing = /\bdata-sequences-contrast-id\s*=\s*(["'])(.*?)\1/i.exec(opening)?.[2];
    if (existing === marker) continue;
    if (existing) return { source, selector: target.selector };
    insertionOffsets.push(matchStart + openingEnd);
  }
  for (const offset of insertionOffsets.sort((left, right) => right - left)) {
    updated =
      updated.slice(0, offset) + ` data-sequences-contrast-id="${marker}"` + updated.slice(offset);
  }
  return { source: updated, selector };
}

function normalizeText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

function injectStyle(source: string, style: string): string {
  if (/<template\b/i.test(source) && /<\/template>/i.test(source)) {
    return source.replace(/<\/template>/i, `${style}\n</template>`);
  }
  if (/<\/head>/i.test(source)) return source.replace(/<\/head>/i, `${style}\n</head>`);
  if (/<\/body>/i.test(source)) return source.replace(/<\/body>/i, `${style}\n</body>`);
  return `${style}\n${source}`;
}

function safeRepairSelector(selector: string): string | null {
  if (
    selector.length === 0 ||
    selector.length > 1_000 ||
    /[{};<@\\\r\n]/.test(selector) ||
    selector.includes(",")
  ) {
    return null;
  }
  return selector;
}

function cssAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parseColor(value: string): Rgb | null {
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value);
  if (rgb) {
    const channels = rgb.slice(1).map(Number);
    if (channels.every((channel) => channel >= 0 && channel <= 255)) {
      return { r: channels[0]!, g: channels[1]!, b: channels[2]! };
    }
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) return null;
  return {
    r: Number.parseInt(hex[1]!.slice(0, 2), 16),
    g: Number.parseInt(hex[1]!.slice(2, 4), 16),
    b: Number.parseInt(hex[1]!.slice(4, 6), 16),
  };
}

function pushUniqueColor(colors: Rgb[], value: Rgb): void {
  if (
    !colors.some(
      (current) => current.r === value.r && current.g === value.g && current.b === value.b,
    )
  ) {
    colors.push(value);
  }
}

function rgbCss(color: Rgb): string {
  return `rgb(${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)})`;
}

function ratio(left: Rgb, right: Rgb): number {
  const high = Math.max(luminance(left), luminance(right));
  const low = Math.min(luminance(left), luminance(right));
  return (high + 0.05) / (low + 0.05);
}

function luminance(color: Rgb): number {
  const channel = (value: number) => {
    const encoded = value / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function rgbToOklab(color: Rgb): Oklab {
  const linear = [color.r, color.g, color.b].map((value) => {
    const encoded = value / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(
    0.4122214708 * linear[0]! + 0.5363325363 * linear[1]! + 0.0514459929 * linear[2]!,
  );
  const m = Math.cbrt(
    0.2119034982 * linear[0]! + 0.6806995451 * linear[1]! + 0.1073969566 * linear[2]!,
  );
  const s = Math.cbrt(
    0.0883024619 * linear[0]! + 0.2817188376 * linear[1]! + 0.6299787005 * linear[2]!,
  );
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb(color: Oklab): Rgb | null {
  const l = (color.l + 0.3963377774 * color.a + 0.2158037573 * color.b) ** 3;
  const m = (color.l - 0.1055613458 * color.a - 0.0638541728 * color.b) ** 3;
  const s = (color.l - 0.0894841775 * color.a - 1.291485548 * color.b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  if (linear.some((value) => value < -0.000_01 || value > 1.000_01)) return null;
  const encoded = linear.map((value) => {
    const clamped = Math.max(0, Math.min(1, value));
    return 255 * (clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055);
  });
  return { r: encoded[0]!, g: encoded[1]!, b: encoded[2]! };
}

function oklabDistance(left: Oklab, right: Oklab): number {
  return Math.hypot(left.l - right.l, left.a - right.a, left.b - right.b);
}
