import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SequenceArtifactV1Schema, type RevisionScopeV1, type SequenceArtifactV1 } from "../shared";
import { errorMessage } from "./errors";
import { existingFileWithin } from "./files";

const MAX_SEQUENCE_BYTES = 256 * 1_024;
const MAX_MOTION_BYTES = 128 * 1_024;

const MotionSidecarV1Schema = z
  .object({
    version: z.literal(1),
    duration: z.number().finite().positive().max(3_600),
    assertions: z
      .array(
        z.union([
          z
            .object({
              kind: z.literal("appearsBy"),
              selector: z.string().min(1).max(1_000),
              bySec: z.number().finite().nonnegative().max(3_600),
            })
            .strict(),
          z
            .object({
              kind: z.literal("before"),
              a: z.string().min(1).max(1_000),
              b: z.string().min(1).max(1_000),
            })
            .strict(),
          z
            .object({
              kind: z.literal("staysInFrame"),
              selector: z.string().min(1).max(1_000),
            })
            .strict(),
          z
            .object({
              kind: z.literal("keepsMoving"),
              withinSelector: z.string().min(1).max(1_000).optional(),
              maxStaticSec: z.number().finite().positive().max(30).optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict();
type MotionAssertionV1 = z.infer<typeof MotionSidecarV1Schema>["assertions"][number];
type StaysInFrameAssertionV1 = Extract<MotionAssertionV1, { kind: "staysInFrame" }>;
type IdentityMotionAssertionV1 = Exclude<MotionAssertionV1, { kind: "keepsMoving" }>;

export type MotionSelectorMissingNormalization = {
  code: "motion_selector_missing";
  assertionKind: IdentityMotionAssertionV1["kind"];
  selectors: string[];
};

export async function readSequenceArtifact(
  projectRoot: string,
  required = true,
): Promise<SequenceArtifactV1 | null> {
  let raw: string;
  try {
    raw = await readFile(join(projectRoot, "sequence.json"), "utf8");
  } catch (error) {
    if (!required && isMissing(error)) return null;
    if (isMissing(error))
      throw new Error("Luna did not produce the required sequence.json artifact");
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_SEQUENCE_BYTES) {
    throw new Error("sequence.json exceeds the 256 KiB semantic-artifact limit");
  }
  try {
    return SequenceArtifactV1Schema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`sequence.json is invalid: ${errorMessage(error)}`);
  }
}

export async function normalizeNumericMusicAnchors(projectRoot: string): Promise<number> {
  const path = join(projectRoot, "sequence.json");
  const raw = await readFile(path, "utf8");
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const beats = (value as { beats?: unknown }).beats;
  if (!Array.isArray(beats)) return 0;

  let repaired = 0;
  for (const beat of beats) {
    if (!beat || typeof beat !== "object" || Array.isArray(beat)) continue;
    const anchors = (beat as { musicAnchors?: unknown }).musicAnchors;
    if (!Array.isArray(anchors)) continue;
    (beat as { musicAnchors: unknown[] }).musicAnchors = anchors.map((anchor) => {
      if (typeof anchor !== "number" || !Number.isFinite(anchor)) return anchor;
      repaired += 1;
      return `at-${anchor}s`;
    });
  }
  if (repaired > 0) await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return repaired;
}

export async function normalizeDomCameraOwners(projectRoot: string): Promise<number> {
  const path = join(projectRoot, "sequence.json");
  const raw = await readFile(path, "utf8");
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const beats = (value as { beats?: unknown }).beats;
  if (!Array.isArray(beats)) return 0;

  let repaired = 0;
  for (const beat of beats) {
    if (!beat || typeof beat !== "object" || Array.isArray(beat)) continue;
    const camera = (beat as { camera?: unknown }).camera;
    if (!camera || typeof camera !== "object" || Array.isArray(camera)) continue;
    const owner = (camera as { owner?: unknown }).owner;
    if (owner === "dom-world" || owner === "three-world") continue;
    (camera as { owner: string }).owner = "dom-world";
    repaired += 1;
  }
  if (repaired > 0) await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return repaired;
}

export function assertLaunchSequenceSemantics(sequence: SequenceArtifactV1): void {
  const failures: string[] = [];
  if (!sequence.format) failures.push("sequence.json must declare format and targetDuration");
  const transitions = sequence.transitions ?? [];
  if (transitions.length !== Math.max(0, sequence.beats.length - 1)) {
    failures.push("sequence.json must declare one intentional transition for every beat boundary");
  }
  for (const [index, beat] of sequence.beats.entries()) {
    const { start, duration } = beat;
    const missingTiming = start === undefined || duration === undefined;
    if (!beat.role || missingTiming) {
      failures.push(`sequence.json beat ${beat.id} must declare role, start, and duration`);
    }
    if (start === undefined || duration === undefined) continue;
    const end = start + duration;
    if (beat.proofTimes.some((proofTime) => proofTime < start || proofTime > end)) {
      failures.push(`sequence.json proof time for ${beat.id} falls outside its beat`);
    }
    if (beat.camera && (beat.camera.arrival < start || beat.camera.hold > end)) {
      failures.push(`sequence.json camera timing for ${beat.id} falls outside its beat`);
    }
    const previous = sequence.beats[index - 1];
    if (previous) {
      if (previous.start !== undefined && start <= previous.start) {
        failures.push("sequence.json beat starts must follow story order");
      }
      if (
        previous.start !== undefined &&
        previous.duration !== undefined &&
        start > previous.start + previous.duration + 0.05
      ) {
        failures.push("sequence.json beats must cover the full timeline without gaps");
      }
      const transition = transitions[index - 1];
      if (transition && Math.abs(transition.at - start) > 0.05) {
        failures.push(
          `sequence.json transition ${transition.id} must align with the ${beat.id} boundary`,
        );
      }
    }
  }
  const first = sequence.beats[0]!;
  if (first.start !== undefined && Math.abs(first.start) > 0.001) {
    failures.push("sequence.json first beat must start at 0 seconds");
  }
  const last = sequence.beats.at(-1)!;
  if (
    sequence.format &&
    last.start !== undefined &&
    last.duration !== undefined &&
    Math.abs(last.start + last.duration - sequence.format.targetDuration) > 0.05
  ) {
    failures.push("sequence.json beat timing must end at format.targetDuration");
  }
  if (sequence.format) {
    const targetDuration = sequence.format.targetDuration;
    if (
      sequence.beats.some(
        (beat) =>
          beat.start !== undefined &&
          beat.duration !== undefined &&
          beat.start + beat.duration > targetDuration + 0.05,
      )
    ) {
      failures.push("sequence.json beat timing cannot extend past format.targetDuration");
    }
  }
  throwAggregatedFailures("sequence.json launch semantics", failures);
}

export async function assertFreshBuildAuthored(
  projectRoot: string,
  sequence: SequenceArtifactV1,
  changedFiles: readonly string[],
): Promise<void> {
  const failures: string[] = [];
  const changed = new Set(changedFiles);
  for (const required of [
    "sequence.json",
    "frame.md",
    "story/design-capsule.json",
    "story/component-plan.json",
    "index.motion.json",
  ]) {
    if (!changed.has(required)) {
      failures.push(`Fresh-build policy requires Luna to author ${required}`);
    }
  }
  if (sequence.beats.length < 2) {
    failures.push("Fresh-build policy requires a causal launch story with at least two beats");
  }
  if (
    sequence.beats.some((beat) => beat.id === "fresh-build") ||
    /generic saas starter shell/i.test(sequence.concept.summary)
  ) {
    failures.push("Fresh-build policy rejected the unchanged starter sequence");
  }
  const declaredFiles = new Set(sequence.beats.flatMap((beat) => beat.implementationFiles));
  const creativeChanged = changedFiles.some(
    (file) => file === "index.html" || declaredFiles.has(file),
  );
  if (!creativeChanged) {
    failures.push("Fresh-build policy requires a sequence-declared composition source to change");
  }
  const sources: string[] = [];
  for (const file of new Set(["index.html", ...declaredFiles])) {
    try {
      sources.push(await readFile(await existingFileWithin(projectRoot, file), "utf8"));
    } catch (error) {
      failures.push(`Fresh-build policy cannot inspect ${file}: ${errorMessage(error)}`);
    }
  }
  // Starter files include implementation notes that legitimately survive a
  // re-author. Only rendered/source-visible content is evidence that the
  // generic shell itself survived, so comments must not trip this guard.
  const assembled = sources.join("\n").replace(/<!--[\s\S]*?-->/g, "");
  if (
    sequence.beats.some((beat) => beat.camera) &&
    /\btransform\s*:\s*none\s*!important\b/i.test(assembled)
  ) {
    failures.push(
      "Fresh-build policy forbids transform: none !important when sequence.json declares camera motion because it can suppress the GSAP camera owner",
    );
  }
  const starterSentinels = [
    "This is the starter story.",
    "A calmer way to ship work.",
    "acme.app/overview",
  ];
  const remaining = starterSentinels.filter((sentinel) => assembled.includes(sentinel));
  if (remaining.length > 0) {
    failures.push(`Fresh-build policy found unchanged starter content: ${remaining.join(", ")}`);
  }
  throwAggregatedFailures("Fresh-build policy", failures);
}

export async function assertLaunchMotionSidecar(
  projectRoot: string,
  sequence: SequenceArtifactV1,
): Promise<void> {
  const path = join(projectRoot, "index.motion.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) throw new Error("Luna did not author the required index.motion.json");
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_MOTION_BYTES) {
    throw new Error("index.motion.json exceeds the 128 KiB motion-evidence limit");
  }
  let motion: z.infer<typeof MotionSidecarV1Schema>;
  try {
    motion = MotionSidecarV1Schema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`index.motion.json is invalid: ${errorMessage(error)}`);
  }
  const failures: string[] = [];
  if (!sequence.format || Math.abs(motion.duration - sequence.format.targetDuration) > 0.05) {
    failures.push("index.motion.json duration must match sequence.json format.targetDuration");
  }
  if (motion.assertions.length < sequence.beats.length) {
    failures.push("index.motion.json needs at least one meaningful assertion per sequence beat");
  }
  const kinds = new Set(motion.assertions.map((assertion) => assertion.kind));
  if (!kinds.has("appearsBy") || !kinds.has("staysInFrame")) {
    failures.push(
      "index.motion.json must verify both a beat arrival and an in-frame product subject",
    );
  }
  if (
    motion.assertions.some(
      (assertion) => assertion.kind === "appearsBy" && assertion.bySec > motion.duration,
    )
  ) {
    failures.push("index.motion.json appearsBy time exceeds the composition duration");
  }
  throwAggregatedFailures("index.motion.json launch evidence", failures);
}

/**
 * Retargets a whole-frame assertion away from an intentional overscan wrapper
 * when the semantic plan provides a repeated, DOM-backed product subject. This
 * keeps camera/world motion measurable without requiring the world itself to
 * remain inside the canvas.
 */
export async function normalizeLaunchMotionSidecarTargets(
  projectRoot: string,
  sequence: SequenceArtifactV1,
  options: {
    onMotionSelectorMissing?: (finding: MotionSelectorMissingNormalization) => void;
  } = {},
): Promise<string | null> {
  const path = join(projectRoot, "index.motion.json");
  const motion = MotionSidecarV1Schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  const files = [
    "index.html",
    ...new Set(sequence.beats.flatMap((beat) => beat.implementationFiles)),
  ];
  const sources = (
    await Promise.all(
      files.map(async (file) => {
        try {
          return await readFile(join(projectRoot, file), "utf8");
        } catch (error) {
          if (isMissing(error)) return "";
          throw error;
        }
      }),
    )
  ).join("\n");
  // Motion assertions are authored against semantic identities. HyperFrames
  // accepts CSS selectors, but an authored entity can expose that identity as
  // either a DOM id or data-hf-id. Resolve simple identity claims to the
  // representation that actually exists before QA so a valid mounted entity
  // does not fail solely because the sidecar chose the other representation.
  let normalizedIdentitySelector = false;
  const normalizeIdentitySelector = (selector: string): string => {
    const id = simpleIdentitySelectorId(selector);
    if (!id) return selector;
    const resolved = domSelectorForEntity(sources, id);
    if (!resolved || resolved === selector) return selector;
    normalizedIdentitySelector = true;
    return resolved;
  };
  for (const assertion of motion.assertions) {
    if (assertion.kind === "appearsBy" || assertion.kind === "staysInFrame") {
      assertion.selector = normalizeIdentitySelector(assertion.selector);
    } else if (assertion.kind === "before") {
      assertion.a = normalizeIdentitySelector(assertion.a);
      assertion.b = normalizeIdentitySelector(assertion.b);
    }
  }
  let droppedMissingAssertion = false;
  // A keepsMoving scope must be measurable in the assembled document. Three
  // proven-dead scopes: overscan/world wrappers, sub-composition roots whose
  // identity is consumed at template mount, and aria-hidden decorative nodes
  // the motion sampler never sees (a live probe failed solely on a rotating
  // aria-hidden orbit). Whole-composition liveness is the one well-defined
  // superset of every such intent.
  let droppedKeepsMovingScope = false;
  for (const assertion of motion.assertions) {
    if (
      assertion.kind === "keepsMoving" &&
      assertion.withinSelector !== undefined &&
      (isUnsafeFrameTarget(assertion.withinSelector) ||
        isUnmeasurableScope(sources, assertion.withinSelector))
    ) {
      delete assertion.withinSelector;
      droppedKeepsMovingScope = true;
    }
  }
  const unsafe = motion.assertions.filter(
    (assertion): assertion is StaysInFrameAssertionV1 =>
      assertion.kind === "staysInFrame" && isUnsafeFrameTarget(assertion.selector),
  );
  let replacement: string | null = null;
  if (unsafe.length > 0) {
    const counts = new Map<string, number>();
    for (const beat of sequence.beats) {
      for (const entity of beat.entities) counts.set(entity.id, (counts.get(entity.id) ?? 0) + 1);
    }
    const candidates = [...counts]
      .filter(([id, count]) => count >= 2 && !isUnsafeFrameTarget(`#${id}`))
      .sort(
        ([leftId, leftCount], [rightId, rightCount]) =>
          rightCount - leftCount ||
          frameTargetPreference(rightId) - frameTargetPreference(leftId) ||
          leftId.localeCompare(rightId),
      );
    replacement =
      candidates
        .map(([id]) => domSelectorForEntity(sources, id))
        .find((selector): selector is string => selector !== null) ?? null;
    if (replacement) {
      for (const assertion of unsafe) assertion.selector = replacement;
    }
  }

  // After reconciliation and safe-target retargeting, a simple identity claim
  // that still matches neither a DOM id nor data-hf-id is objectively dead.
  // Drop the whole assertion; complex and class selectors remain author-owned
  // because source text alone cannot prove their assembled-DOM match set.
  motion.assertions = motion.assertions.filter((assertion) => {
    if (assertion.kind === "keepsMoving") return true;
    const missingSelectors = assertionIdentitySelectors(assertion).filter((selector) => {
      const id = simpleIdentitySelectorId(selector);
      return id !== null && domSelectorForEntity(sources, id) === null;
    });
    if (missingSelectors.length === 0) return true;
    droppedMissingAssertion = true;
    options.onMotionSelectorMissing?.({
      code: "motion_selector_missing",
      assertionKind: assertion.kind,
      selectors: [...new Set(missingSelectors)],
    });
    return false;
  });
  if (droppedKeepsMovingScope || normalizedIdentitySelector || droppedMissingAssertion || replacement) {
    await writeFile(path, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
  }
  return replacement;
}

function assertionIdentitySelectors(assertion: MotionAssertionV1): string[] {
  if (assertion.kind === "appearsBy" || assertion.kind === "staysInFrame") {
    return [assertion.selector];
  }
  if (assertion.kind === "before") return [assertion.a, assertion.b];
  return [];
}

function simpleIdentitySelectorId(selector: string): string | null {
  const trimmed = selector.trim();
  const id = /^#([A-Za-z][\w-]*)$/.exec(trimmed)?.[1];
  if (id) return id;
  const hfId = /^\[\s*data-hf-id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]$/i.exec(
    trimmed,
  );
  return hfId?.[1] ?? hfId?.[2] ?? hfId?.[3] ?? null;
}

function isUnsafeFrameTarget(selector: string): boolean {
  return /(^|[^a-z0-9])(root|camera|world|canvas|stage|scene)([^a-z0-9]|$)/i.test(selector);
}

/**
 * A liveness scope is unmeasurable when its simple id/data-hf-id selector
 * matches nothing, the matched element is aria-hidden decoration, has no
 * element descendants, or its authored initial style has zero extent.
 * HyperFrames samples keepsMoving from descendants of the scoped root rather
 * than the root itself, so a leaf scope can never produce a liveness signature.
 * It also samples from time zero, so a progress fill that starts at width:0 has
 * no measurable box even when it becomes visible later.
 */
function isUnmeasurableScope(sources: string, selector: string): boolean {
  const trimmed = selector.trim();
  const id = /^#([A-Za-z][\w-]*)$/.exec(trimmed)?.[1];
  const hfId = /^\[\s*data-hf-id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]$/i.exec(trimmed);
  const attribute = id ? "id" : hfId ? "data-hf-id" : null;
  const value = id ?? hfId?.[1] ?? hfId?.[2] ?? hfId?.[3];
  if (!attribute || !value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagMatch = new RegExp(
    `<[a-z][\\w:-]*\\b[^>]*\\b${attribute}\\s*=\\s*(["'])${escaped}\\1[^>]*>`,
    "i",
  ).exec(sources);
  const tag = tagMatch?.[0];
  if (!tag || tagMatch.index === undefined) return true;
  if (/\baria-hidden\s*=\s*(["'])true\1/i.test(tag)) return true;
  if (!hasElementDescendants(sources, tagMatch.index, tag)) return true;
  const inlineStyle = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2] ?? "";
  if (hasZeroExtentDeclarations(inlineStyle)) return true;

  const cssSelectors = new Set([trimmed]);
  const domId = /\bid\s*=\s*(["'])([A-Za-z][\w-]*)\1/i.exec(tag)?.[2];
  if (domId) cssSelectors.add(`#${domId}`);
  const styleText = [...sources.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1] ?? "")
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of styleText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const ruleSelectors = match[1] ?? "";
    if (
      [...cssSelectors].some((candidate) => selectorListContains(ruleSelectors, candidate)) &&
      hasZeroExtentDeclarations(match[2] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

function hasElementDescendants(sources: string, tagIndex: number, openingTag: string): boolean {
  const tagName = /^<([a-z][\w:-]*)\b/i.exec(openingTag)?.[1];
  if (!tagName) return true;
  if (/\/\s*>$/.test(openingTag) || VOID_HTML_ELEMENTS.has(tagName.toLowerCase())) return false;
  const contentStart = tagIndex + openingTag.length;
  const closingTag = new RegExp(`</${escapeRegExp(tagName)}\\s*>`, "ig");
  closingTag.lastIndex = contentStart;
  const closingMatch = closingTag.exec(sources);
  if (!closingMatch) return true;
  return /<[a-z][\w:-]*\b[^>]*>/i.test(sources.slice(contentStart, closingMatch.index));
}

const VOID_HTML_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function selectorListContains(selectorList: string, selector: string): boolean {
  return selectorList
    .split(",")
    .some((candidate) =>
      new RegExp(`(^|[\\s>+~])${escapeRegExp(selector)}(?![A-Za-z0-9_-])`, "i").test(
        candidate.trim(),
      ),
    );
}

function hasZeroExtentDeclarations(declarations: string): boolean {
  return (
    /(?:^|;)\s*(?:width|height)\s*:\s*0(?:\.0+)?(?:[a-z]+|%)?\s*(?:!important\s*)?(?:;|$)/i.test(
      declarations,
    ) ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(
      declarations,
    ) ||
    /\btransform\s*:[^;]*\bscale(?:x|y)?\(\s*0(?:\.0+)?\s*\)/i.test(declarations)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function frameTargetPreference(id: string): number {
  return /(^|-)(product|app|dashboard|surface|panel|window|control|card)(-|$)/i.test(id) ? 1 : 0;
}

function domSelectorForEntity(source: string, id: string): string | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:<|\\s)id\\s*=\\s*(["'])${escaped}\\1`, "i").test(source)) return `#${id}`;
  if (new RegExp(`(?:<|\\s)data-hf-id\\s*=\\s*(["'])${escaped}\\1`, "i").test(source)) {
    return `[data-hf-id="${id}"]`;
  }
  return null;
}

export function resolveRevisionScope(
  sequence: SequenceArtifactV1,
  requested: RevisionScopeV1,
): RevisionScopeV1 {
  const beats = new Map(sequence.beats.map((beat) => [beat.id, beat]));
  for (const beatId of requested.targetBeatIds) {
    if (!beats.has(beatId)) throw new Error(`Revision target beat does not exist: ${beatId}`);
  }
  const targetEntities = new Set(requested.targetEntityIds);
  if (targetEntities.size > 0) {
    const available = new Set(
      requested.targetBeatIds.flatMap(
        (beatId) => beats.get(beatId)?.entities.map((item) => item.id) ?? [],
      ),
    );
    for (const entityId of targetEntities) {
      if (!available.has(entityId)) {
        throw new Error(`Revision target entity is not owned by the selected beat: ${entityId}`);
      }
    }
  }

  const targetBeatIds = new Set(requested.targetBeatIds);
  const unchangedProofs =
    requested.unchangedProofs.length > 0
      ? requested.unchangedProofs
      : sequence.beats
          .filter((beat) => !targetBeatIds.has(beat.id))
          .flatMap((beat) =>
            beat.proofTimes[0] === undefined ? [] : [{ beatId: beat.id, time: beat.proofTimes[0] }],
          );
  if (unchangedProofs.length === 0) {
    throw new Error("Revision scope needs at least one proof time in an unchanged beat");
  }
  for (const proof of unchangedProofs) {
    const beat = beats.get(proof.beatId);
    if (!beat) throw new Error(`Unchanged proof beat does not exist: ${proof.beatId}`);
    if (targetBeatIds.has(proof.beatId)) {
      throw new Error(`Unchanged proof cannot point at a revised beat: ${proof.beatId}`);
    }
  }
  return {
    targetBeatIds: [...new Set(requested.targetBeatIds)],
    targetEntityIds: [...targetEntities],
    unchangedProofs: dedupeProofs(unchangedProofs),
  };
}

export function revisionImplementationFiles(
  sequence: SequenceArtifactV1,
  scope: RevisionScopeV1,
): string[] {
  const targets = new Set(scope.targetBeatIds);
  const files = sequence.beats
    .filter((beat) => targets.has(beat.id))
    .flatMap((beat) => beat.implementationFiles);
  return [...new Set([...files, "sequence.json"])].sort();
}

export function assertSemanticRevisionContained(
  before: SequenceArtifactV1,
  after: SequenceArtifactV1,
  scope: RevisionScopeV1,
): void {
  if (stableJson(before.concept) !== stableJson(after.concept)) {
    throw new Error("Revision changed the locked project concept outside its declared scope");
  }
  const beforeIds = before.beats.map((beat) => beat.id);
  const afterIds = after.beats.map((beat) => beat.id);
  if (stableJson(beforeIds) !== stableJson(afterIds)) {
    throw new Error("Revision added, removed, or reordered beats outside its declared scope");
  }
  const targets = new Set(scope.targetBeatIds);
  for (const prior of before.beats) {
    const next = after.beats.find((beat) => beat.id === prior.id);
    if (!next) throw new Error(`Revision removed beat ${prior.id}`);
    if (!targets.has(prior.id) && stableJson(prior) !== stableJson(next)) {
      throw new Error(`Revision changed unchanged beat ${prior.id}`);
    }
    if (targets.has(prior.id) && scope.targetEntityIds.length > 0) {
      assertEntityRevisionContained(prior, next, new Set(scope.targetEntityIds));
    }
  }
  assertOverlapIntentRevisionContained(before, after, scope);
  if (!after.revision || stableJson(after.revision) !== stableJson(scope)) {
    throw new Error("sequence.json did not record the exact enforced revision scope");
  }
}

function assertOverlapIntentRevisionContained(
  before: SequenceArtifactV1,
  after: SequenceArtifactV1,
  scope: RevisionScopeV1,
): void {
  const targets = new Set(scope.targetBeatIds);
  const targetedEntities = new Set(scope.targetEntityIds);
  const ownership = new Map<string, { beatId: string; topEntityId: string }>();
  for (const beat of before.beats) {
    for (const entity of beat.entities) {
      ownership.set(entity.id, { beatId: beat.id, topEntityId: entity.id });
      for (const part of entity.parts)
        ownership.set(part, { beatId: beat.id, topEntityId: entity.id });
    }
  }
  const beforeById = new Map(before.overlapIntents.map((intent) => [intent.id, intent]));
  const afterById = new Map(after.overlapIntents.map((intent) => [intent.id, intent]));
  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const prior = beforeById.get(id);
    const next = afterById.get(id);
    if (stableJson(prior) === stableJson(next)) continue;
    const changed = next ?? prior;
    if (!changed) continue;
    for (const entityId of changed.entities) {
      const owner = ownership.get(entityId);
      if (!owner || !targets.has(owner.beatId)) {
        throw new Error(`Revision changed overlap intent ${id} outside its target beats`);
      }
      if (targetedEntities.size > 0 && !targetedEntities.has(owner.topEntityId)) {
        throw new Error(`Revision changed overlap intent ${id} outside its target entities`);
      }
    }
  }
}

function assertEntityRevisionContained(
  before: SequenceArtifactV1["beats"][number],
  after: SequenceArtifactV1["beats"][number],
  targets: ReadonlySet<string>,
): void {
  const withoutEntities = (beat: typeof before) => {
    const { entities: _entities, ...rest } = beat;
    return rest;
  };
  if (stableJson(withoutEntities(before)) !== stableJson(withoutEntities(after))) {
    throw new Error(`Entity-targeted revision changed beat-level meaning in ${before.id}`);
  }
  const beforeIds = before.entities.map((entity) => entity.id);
  const afterIds = after.entities.map((entity) => entity.id);
  if (stableJson(beforeIds) !== stableJson(afterIds)) {
    throw new Error(`Entity-targeted revision changed the entity inventory in ${before.id}`);
  }
  for (const entity of before.entities) {
    if (targets.has(entity.id)) continue;
    const next = after.entities.find((candidate) => candidate.id === entity.id);
    if (!next || stableJson(entity) !== stableJson(next)) {
      throw new Error(`Revision changed unchanged entity ${entity.id}`);
    }
  }
}

function dedupeProofs(proofs: readonly { beatId: string; time: number }[]) {
  const seen = new Set<string>();
  return proofs.filter((proof) => {
    const key = `${proof.beatId}\0${proof.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function throwAggregatedFailures(scope: string, failures: readonly string[]): void {
  const unique = [...new Set(failures)];
  if (unique.length === 0) return;
  if (unique.length === 1) throw new Error(unique[0]);
  throw new Error(
    `${scope} found ${unique.length} mismatches:\n${unique
      .map((failure, index) => `${index + 1}. ${failure}`)
      .join("\n")}`,
  );
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

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
