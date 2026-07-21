import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ComponentPlanV2Schema,
  type ComponentPlanV2,
  type DesignCapsuleV1,
  type ImageInputV1,
  type SequenceArtifactV1,
} from "../shared";
import { errorMessage } from "./errors";
import { atomicWriteJson, existingFileWithin, sha256 } from "./files";
import { elementsWithAttribute, parseHtmlEvidence, type HtmlEvidence } from "./html-evidence";

const COMPONENT_PLAN_PATH = "story/component-plan.json";
const MAX_COMPONENT_PLAN_BYTES = 128 * 1_024;

export interface ComponentPlanStateCanonicalization {
  changed: boolean;
  removedStates: Array<{ componentId: string; stateIds: string[] }>;
  removedInteractions: Array<{ componentId: string; interactionIds: string[] }>;
}

export interface ComponentPlanContainmentNormalization {
  changed: boolean;
  movedParts: Array<{ componentId: string; partId: string; implementationFile: string }>;
}

export interface ComponentPlanReferenceBindingNormalization {
  changed: boolean;
  normalizedBindings: Array<{
    imagePath: string;
    implementationFile: string;
    beforeBeatIds: string | null;
    afterBeatIds: string;
  }>;
}

/**
 * Reconciles non-rendering reference evidence with the already locked
 * component plan when exactly one recreated DOM root owns the image binding.
 * The annotation does not affect pixels or choreography; missing and
 * ambiguous roots remain author-owned contract failures.
 */
export async function normalizeComponentPlanReferenceBindings(
  projectRoot: string,
): Promise<ComponentPlanReferenceBindingNormalization> {
  const unchanged = (): ComponentPlanReferenceBindingNormalization => ({
    changed: false,
    normalizedBindings: [],
  });
  const planPath = join(projectRoot, "story", "component-plan.json");
  let plan: ComponentPlanV2;
  try {
    const metadata = await stat(planPath);
    if (!metadata.isFile() || metadata.size > MAX_COMPONENT_PLAN_BYTES) return unchanged();
    plan = ComponentPlanV2Schema.parse(JSON.parse(await readFile(planPath, "utf8")) as unknown);
  } catch {
    return unchanged();
  }
  if (plan.sourceImageBindings.length === 0) return unchanged();

  const htmlByPath = new Map<string, HtmlEvidence>();
  const sourcePaths = new Map<string, string>();
  try {
    for (const component of plan.components) {
      for (const implementationFile of component.implementationFiles) {
        if (!/^(?:index\.html|(?:compositions|scenes)\/.+\.html?)$/i.test(implementationFile)) {
          return unchanged();
        }
        if (htmlByPath.has(implementationFile)) continue;
        const sourcePath = await existingFileWithin(projectRoot, implementationFile);
        htmlByPath.set(
          implementationFile,
          parseHtmlEvidence(implementationFile, await readFile(sourcePath, "utf8")),
        );
        sourcePaths.set(implementationFile, sourcePath);
      }
    }
  } catch {
    return unchanged();
  }

  const normalizedBindings: ComponentPlanReferenceBindingNormalization["normalizedBindings"] = [];
  for (const binding of plan.sourceImageBindings) {
    const matches = elementsWithAttribute(
      [...htmlByPath.values()],
      "data-reference-image",
      binding.imagePath,
    ).filter((match) => match.element.getAttribute("data-reference-mode") === "recreated");
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    const afterBeatIds = binding.beatIds.join(" ");
    const beforeBeatIds = match.element.getAttribute("data-reference-beats");
    if (beforeBeatIds === afterBeatIds) continue;
    match.element.setAttribute("data-reference-beats", afterBeatIds);
    normalizedBindings.push({
      imagePath: binding.imagePath,
      implementationFile: match.file.path,
      beforeBeatIds,
      afterBeatIds,
    });
  }

  if (normalizedBindings.length === 0) return unchanged();
  const changedFiles = new Set(normalizedBindings.map((binding) => binding.implementationFile));
  for (const implementationFile of changedFiles) {
    const evidence = htmlByPath.get(implementationFile)!;
    refreshTemplateSerialization(evidence);
    await writeFile(sourcePaths.get(implementationFile)!, String(evidence.document), "utf8");
  }
  return { changed: true, normalizedBindings };
}

/**
 * Repairs the objective subset of component-containment failures where the
 * authored root and part each exist exactly once in the same HTML tree. The
 * existing node is relocated without inventing markup or changing the locked
 * component plan; ambiguous or cross-file bindings remain author-owned.
 */
export async function normalizeComponentPlanContainment(
  projectRoot: string,
): Promise<ComponentPlanContainmentNormalization> {
  const unchanged = (): ComponentPlanContainmentNormalization => ({
    changed: false,
    movedParts: [],
  });
  const path = join(projectRoot, "story", "component-plan.json");
  let plan: ComponentPlanV2;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_COMPONENT_PLAN_BYTES) return unchanged();
    plan = ComponentPlanV2Schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return unchanged();
  }

  const htmlByPath = new Map<string, HtmlEvidence>();
  const sourcePaths = new Map<string, string>();
  const movedParts: ComponentPlanContainmentNormalization["movedParts"] = [];

  try {
    for (const component of plan.components) {
      const htmlFiles: HtmlEvidence[] = [];
      for (const implementationFile of component.implementationFiles) {
        if (!/^(?:index\.html|(?:compositions|scenes)\/.+\.html?)$/i.test(implementationFile)) {
          return unchanged();
        }
        let evidence = htmlByPath.get(implementationFile);
        if (!evidence) {
          const sourcePath = await existingFileWithin(projectRoot, implementationFile);
          evidence = parseHtmlEvidence(implementationFile, await readFile(sourcePath, "utf8"));
          htmlByPath.set(implementationFile, evidence);
          sourcePaths.set(implementationFile, sourcePath);
        }
        htmlFiles.push(evidence);
      }

      const rootMatches = elementsWithAttribute(htmlFiles, "data-hf-id", component.rootHfId);
      if (rootMatches.length !== 1) continue;
      const rootMatch = rootMatches[0]!;
      for (const part of component.parts) {
        const partMatches = elementsWithAttribute(htmlFiles, "data-hf-id", part.hfId);
        if (partMatches.length !== 1) continue;
        const partMatch = partMatches[0]!;
        if (rootMatch.element.contains(partMatch.element)) continue;
        if (
          rootMatch.file.path !== partMatch.file.path ||
          partMatch.element.contains(rootMatch.element) ||
          !shareSerializableTree(rootMatch.file, rootMatch.element, partMatch.element)
        ) {
          continue;
        }

        const rootIndex = rootMatch.file.elements.indexOf(rootMatch.element);
        const partIndex = rootMatch.file.elements.indexOf(partMatch.element);
        if (partIndex < rootIndex) rootMatch.element.prepend(partMatch.element);
        else rootMatch.element.append(partMatch.element);
        movedParts.push({
          componentId: component.id,
          partId: part.id,
          implementationFile: rootMatch.file.path,
        });
      }
    }
  } catch {
    return unchanged();
  }

  if (movedParts.length === 0) return unchanged();
  const changedFiles = new Set(movedParts.map((part) => part.implementationFile));
  for (const implementationFile of changedFiles) {
    const evidence = htmlByPath.get(implementationFile)!;
    refreshTemplateSerialization(evidence);
    await writeFile(sourcePaths.get(implementationFile)!, String(evidence.document), "utf8");
  }
  return { changed: true, movedParts };
}

/**
 * Makes component state claims describe the authored root DOM without inventing
 * state machinery. This is intentionally conservative: if pruning would leave
 * a component without a state, or the plan without any multi-state/interactive
 * component, disk is left untouched so the author receives the real contract
 * failure.
 */
export async function canonicalizeComponentPlanStateClaims(
  projectRoot: string,
): Promise<ComponentPlanStateCanonicalization> {
  const unchanged = (): ComponentPlanStateCanonicalization => ({
    changed: false,
    removedStates: [],
    removedInteractions: [],
  });
  const path = join(projectRoot, "story", "component-plan.json");
  let plan: ComponentPlanV2;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_COMPONENT_PLAN_BYTES) return unchanged();
    plan = ComponentPlanV2Schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    // Parsing, path, and schema failures belong to normal contract validation;
    // a deterministic state canonicalizer must not obscure or replace them.
    return unchanged();
  }

  const htmlByPath = new Map<string, HtmlEvidence>();
  const removedStates: ComponentPlanStateCanonicalization["removedStates"] = [];
  const removedInteractions: ComponentPlanStateCanonicalization["removedInteractions"] = [];
  const components: ComponentPlanV2["components"] = [];

  try {
    for (const component of plan.components) {
      const htmlFiles: HtmlEvidence[] = [];
      for (const implementationFile of component.implementationFiles) {
        if (!/^(?:index\.html|(?:compositions|scenes)\/.+\.html?)$/i.test(implementationFile)) {
          return unchanged();
        }
        let evidence = htmlByPath.get(implementationFile);
        if (!evidence) {
          const file = await existingFileWithin(projectRoot, implementationFile);
          evidence = parseHtmlEvidence(implementationFile, await readFile(file, "utf8"));
          htmlByPath.set(implementationFile, evidence);
        }
        htmlFiles.push(evidence);
      }

      const rootMatches = elementsWithAttribute(htmlFiles, "data-hf-id", component.rootHfId);
      if (
        rootMatches.length !== 1 ||
        rootMatches[0]!.element.getAttribute("data-component") !== component.archetype
      ) {
        return unchanged();
      }
      const rootMatch = rootMatches[0]!;
      const states = component.states.filter((state) =>
        isRootStateImplemented(rootMatch, component, state.id),
      );
      if (states.length === 0) return unchanged();

      const retainedStateIds = new Set(states.map((state) => state.id));
      const interactions = component.interactions.filter(
        (interaction) =>
          (!interaction.fromState || retainedStateIds.has(interaction.fromState)) &&
          (!interaction.toState || retainedStateIds.has(interaction.toState)),
      );
      const removedStateIds = component.states
        .filter((state) => !retainedStateIds.has(state.id))
        .map((state) => state.id);
      const retainedInteractionIds = new Set(interactions.map((interaction) => interaction.id));
      const removedInteractionIds = component.interactions
        .filter((interaction) => !retainedInteractionIds.has(interaction.id))
        .map((interaction) => interaction.id);
      if (removedStateIds.length > 0) {
        removedStates.push({ componentId: component.id, stateIds: removedStateIds });
      }
      if (removedInteractionIds.length > 0) {
        removedInteractions.push({
          componentId: component.id,
          interactionIds: removedInteractionIds,
        });
      }
      components.push({ ...component, states, interactions });
    }
  } catch {
    return unchanged();
  }

  if (removedStates.length === 0) return unchanged();
  if (
    !components.some(
      (component) => component.states.length > 1 || component.interactions.length > 0,
    )
  ) {
    return unchanged();
  }

  const canonicalPlan = ComponentPlanV2Schema.safeParse({ ...plan, components });
  if (!canonicalPlan.success) return unchanged();
  await atomicWriteJson(path, ComponentPlanV2Schema, canonicalPlan.data);
  return { changed: true, removedStates, removedInteractions };
}

export async function assertComponentPlan(
  projectRoot: string,
  sequence: SequenceArtifactV1,
  expectedImages?: readonly ImageInputV1[],
  designCapsule?: DesignCapsuleV1,
): Promise<ComponentPlanV2> {
  const path = join(projectRoot, "story", "component-plan.json");
  let raw: string;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_COMPONENT_PLAN_BYTES) {
      throw new Error("story/component-plan.json exceeds the 128 KiB component-plan limit");
    }
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`The component owner did not author the required ${COMPONENT_PLAN_PATH}`);
    }
    throw error;
  }
  let plan: ComponentPlanV2;
  try {
    plan = ComponentPlanV2Schema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`${COMPONENT_PLAN_PATH} is invalid: ${errorMessage(error)}`);
  }

  if (expectedImages) {
    const expected = expectedImages.map((image) => image.path);
    const actual = plan.sourceImages;
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(
        `${COMPONENT_PLAN_PATH} must list exactly the host-supplied reference images`,
      );
    }
    const expectedMode = expected.length > 0 ? "reference-derived" : "synthetic";
    if (plan.mode !== expectedMode) {
      throw new Error(`${COMPONENT_PLAN_PATH} mode must be ${expectedMode} for this fresh build`);
    }
    const bindingPaths = plan.sourceImageBindings.map((binding) => binding.imagePath);
    if (JSON.stringify(expected) !== JSON.stringify(bindingPaths)) {
      throw new Error(
        `${COMPONENT_PLAN_PATH} must assign every supplied reference image to story beats in host order`,
      );
    }
    for (const expectedImage of expectedImages) {
      const imagePath = await existingFileWithin(projectRoot, expectedImage.path);
      const bytes = await readFile(imagePath);
      if (bytes.byteLength !== expectedImage.bytes || sha256(bytes) !== expectedImage.sha256) {
        throw new Error(
          `${COMPONENT_PLAN_PATH} source image was modified after trusted intake: ${expectedImage.path}`,
        );
      }
    }
  }

  if (designCapsule) {
    if (plan.designCapsuleId !== designCapsule.id) {
      throw new Error(`${COMPONENT_PLAN_PATH} designCapsuleId must bind to ${designCapsule.id}`);
    }
    const reservedTokens = {
      "color-background": designCapsule.palette.background,
      "color-surface": designCapsule.palette.surface,
      "color-text": designCapsule.palette.text,
      "color-muted": designCapsule.palette.muted,
      "color-accent": designCapsule.palette.accent,
      "color-accent-text": designCapsule.palette.accentText,
      "color-border": designCapsule.palette.border,
    } as const;
    for (const [token, expected] of Object.entries(reservedTokens)) {
      if (plan.tokens[token] !== expected) {
        throw new Error(
          `${COMPONENT_PLAN_PATH} token ${token} must match design capsule value ${expected}`,
        );
      }
    }
  }

  const beatsById = new Map(sequence.beats.map((beat) => [beat.id, beat]));
  const componentFailures: string[] = [];
  const reportComponentFailure = (message: string): void => {
    componentFailures.push(message);
  };
  for (const binding of plan.sourceImageBindings) {
    for (const beatId of binding.beatIds) {
      if (!beatsById.has(beatId)) {
        reportComponentFailure(
          `${COMPONENT_PLAN_PATH} reference ${binding.imagePath} names unknown story beat ${beatId}`,
        );
      }
    }
  }
  if (plan.sourceImageBindings.length > 1) {
    const boundBeatIds = new Set(plan.sourceImageBindings.flatMap((binding) => binding.beatIds));
    if (boundBeatIds.size < 2) {
      reportComponentFailure(
        `${COMPONENT_PLAN_PATH} must progress multiple supplied references across at least two story beats`,
      );
    }
  }
  const htmlByPath = new Map<string, HtmlEvidence>();
  const reusableBeatCount = Math.min(2, sequence.beats.length);
  let hasPersistentComponent = false;
  let hasKnownArchetype = false;
  let hasInvokableState = false;
  const unimplementedRootStates: string[] = [];
  for (const component of plan.components) {
    if (component.continuity === "persistent") {
      if (component.usedInBeatIds.length < reusableBeatCount) {
        reportComponentFailure(
          `${COMPONENT_PLAN_PATH} persistent component ${component.id} must bind to at least ${reusableBeatCount} sequence beats`,
        );
      }
      hasPersistentComponent = true;
    }
    hasKnownArchetype ||= component.archetype !== "custom";
    for (const beatId of component.usedInBeatIds) {
      const beat = beatsById.get(beatId);
      if (!beat) {
        reportComponentFailure(
          `${COMPONENT_PLAN_PATH} component ${component.id} references unknown beat ${beatId}`,
        );
        continue;
      }
      const entity = beat.entities.find((candidate) => candidate.id === component.id);
      if (!entity) {
        reportComponentFailure(
          `${COMPONENT_PLAN_PATH} component ${component.id} must be a semantic entity in beat ${beatId}`,
        );
      }
      if (
        !component.implementationFiles.some((implementationFile) =>
          beat.implementationFiles.includes(implementationFile),
        )
      ) {
        reportComponentFailure(
          `${COMPONENT_PLAN_PATH} component ${component.id} must share an implementation file with beat ${beatId}`,
        );
      }
      if (entity) {
        const entityParts = new Set(entity.parts);
        for (const part of component.parts) {
          if (part.morphAnchor && !entityParts.has(part.id)) {
            reportComponentFailure(
              `${COMPONENT_PLAN_PATH} morph anchor ${component.id}/${part.id} must be a semantic part in beat ${beatId}`,
            );
          }
        }
      }
    }
    hasInvokableState ||= component.states.length > 1 || component.interactions.length > 0;
    const htmlFiles: HtmlEvidence[] = [];
    for (const implementationFile of component.implementationFiles) {
      if (!/^(?:index\.html|(?:compositions|scenes)\/.+\.html?)$/i.test(implementationFile)) {
        reportComponentFailure(
          `${COMPONENT_PLAN_PATH} component ${component.id} must bind to composition HTML`,
        );
        continue;
      }
      let evidence = htmlByPath.get(implementationFile);
      if (!evidence) {
        try {
          const file = await existingFileWithin(projectRoot, implementationFile);
          evidence = parseHtmlEvidence(implementationFile, await readFile(file, "utf8"));
          htmlByPath.set(implementationFile, evidence);
        } catch (error) {
          reportComponentFailure(errorMessage(error));
          continue;
        }
      }
      htmlFiles.push(evidence);
    }
    if (htmlFiles.length === 0) continue;
    const rootMatches = elementsWithAttribute(htmlFiles, "data-hf-id", component.rootHfId);
    if (rootMatches.length !== 1) {
      reportComponentFailure(
        `${COMPONENT_PLAN_PATH} ${component.id} root must bind to exactly one data-hf-id (found ${rootMatches.length})`,
      );
      continue;
    }
    const rootMatch = rootMatches[0]!;
    if (rootMatch.element.getAttribute("data-component") !== component.archetype) {
      reportComponentFailure(
        `${COMPONENT_PLAN_PATH} component ${component.id} root must declare data-component="${component.archetype}"`,
      );
    }
    for (const part of component.parts) {
      const partMatches = elementsWithAttribute(htmlFiles, "data-hf-id", part.hfId);
      if (partMatches.length !== 1) {
        reportComponentFailure(
          `${COMPONENT_PLAN_PATH} ${component.id} part ${part.id} must bind to exactly one data-hf-id (found ${partMatches.length})`,
        );
        continue;
      }
      if (!rootMatch.element.contains(partMatches[0]!.element)) {
        reportComponentFailure(
          `${COMPONENT_PLAN_PATH} ${component.id} part ${part.id} must be inside its component root`,
        );
      }
    }
    for (const state of component.states) {
      if (!isRootStateImplemented(rootMatch, component, state.id)) {
        unimplementedRootStates.push(
          `${COMPONENT_PLAN_PATH} state ${component.id}/${state.id} is not implemented on its root`,
        );
      }
    }
  }
  if (unimplementedRootStates.length > 0) {
    reportComponentFailure(
      unimplementedRootStates.length === 1
        ? unimplementedRootStates[0]!
        : `${COMPONENT_PLAN_PATH} has ${unimplementedRootStates.length} unimplemented root states:\n${unimplementedRootStates
            .map((message, index) => `${index + 1}. ${message}`)
            .join("\n")}`,
    );
  }
  if (expectedImages && expectedImages.length > 0) {
    const expectedPaths = new Set(expectedImages.map((image) => image.path));
    const renderedReferencePaths = [...htmlByPath.values()].flatMap((evidence) =>
      evidence.elements
        .map((element) => element.getAttribute("src"))
        .filter((src): src is string => src !== null && expectedPaths.has(src)),
    );
    if (renderedReferencePaths.length > 0) {
      reportComponentFailure(
        `${COMPONENT_PLAN_PATH} host screenshots are reference-only and cannot be rendered as image planes: ${renderedReferencePaths.join(", ")}`,
      );
    }
    const recreatedReferences = new Map(
      [...htmlByPath.values()].flatMap((evidence) =>
        evidence.elements
          .filter((element) => element.getAttribute("data-reference-mode") === "recreated")
          .map((element) => [
            element.getAttribute("data-reference-image"),
            element.getAttribute("data-reference-beats"),
          ])
          .filter((entry): entry is [string, string | null] => entry[0] !== null),
      ),
    );
    const missingReferences = expectedImages
      .map((image) => image.path)
      .filter((imagePath) => !recreatedReferences.has(imagePath));
    if (missingReferences.length > 0) {
      reportComponentFailure(
        `${COMPONENT_PLAN_PATH} must bind every supplied reference to a code-native recreated state with data-reference-image, data-reference-mode="recreated", and data-reference-beats; missing: ${missingReferences.join(", ")}`,
      );
    }
    for (const binding of plan.sourceImageBindings) {
      const actualBeatIds = recreatedReferences.get(binding.imagePath);
      if (actualBeatIds !== binding.beatIds.join(" ")) {
        reportComponentFailure(
          `${COMPONENT_PLAN_PATH} recreated reference ${binding.imagePath} must declare data-reference-beats="${binding.beatIds.join(" ")}" in renderable component HTML`,
        );
      }
    }
  }
  if (!hasPersistentComponent) {
    reportComponentFailure(
      `${COMPONENT_PLAN_PATH} needs at least one persistent component reused across the sequence`,
    );
  }
  if (!hasKnownArchetype) {
    reportComponentFailure(
      `${COMPONENT_PLAN_PATH} needs at least one typed SaaS component archetype`,
    );
  }
  if (!hasInvokableState) {
    reportComponentFailure(
      `${COMPONENT_PLAN_PATH} needs at least one multi-state or interactive product component`,
    );
  }
  const uniqueComponentFailures = [...new Set(componentFailures)];
  if (uniqueComponentFailures.length > 0) {
    throw new Error(
      uniqueComponentFailures.length === 1
        ? uniqueComponentFailures[0]
        : `${COMPONENT_PLAN_PATH} found ${uniqueComponentFailures.length} mismatches:\n${uniqueComponentFailures
            .map((failure, index) => `${index + 1}. ${failure}`)
            .join("\n")}`,
    );
  }
  return plan;
}

function isRootStateImplemented(
  rootMatch: ReturnType<typeof elementsWithAttribute>[number],
  component: ComponentPlanV2["components"][number],
  stateId: string,
): boolean {
  return (
    rootMatch.element.getAttribute(component.stateAttribute) === stateId ||
    hasRootStateSelector(
      rootMatch.file.styleText,
      component.rootHfId,
      component.archetype,
      rootMatch.element.getAttribute("id"),
      component.stateAttribute,
      stateId,
    ) ||
    hasRootStateScript(
      rootMatch.file.scriptText,
      rootMatch.element.getAttribute("id"),
      component.stateAttribute,
      stateId,
    )
  );
}

function shareSerializableTree(file: HtmlEvidence, left: Element, right: Element): boolean {
  const leftTemplate = containingTemplate(file, left);
  const rightTemplate = containingTemplate(file, right);
  return leftTemplate === rightTemplate;
}

function containingTemplate(file: HtmlEvidence, element: Element): HTMLTemplateElement | null {
  const matches = file.elements.filter(
    (candidate): candidate is HTMLTemplateElement =>
      candidate.tagName.toLowerCase() === "template" &&
      Boolean((candidate as HTMLTemplateElement).content?.contains(element)),
  );
  return matches.at(-1) ?? null;
}

function refreshTemplateSerialization(file: HtmlEvidence): void {
  const templates = file.elements.filter(
    (element): element is HTMLTemplateElement => element.tagName.toLowerCase() === "template",
  );
  for (const template of templates.reverse()) {
    const content = Array.from(template.content.childNodes)
      .map((node) => String(node))
      .join("");
    template.innerHTML = content;
  }
}

function hasRootStateScript(
  script: string,
  rootId: string | null,
  stateAttribute: string,
  stateId: string,
): boolean {
  if (!rootId || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(rootId)) return false;
  const target = escapeRegExp(`#${rootId}`);
  const attribute = escapeRegExp(stateAttribute);
  const state = escapeRegExp(stateId);
  const selectorHelpers = [
    ...script.matchAll(
      /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:\(\s*([a-zA-Z_$][\w$]*)\s*\)|([a-zA-Z_$][\w$]*))\s*=>\s*(?:\{[\s\S]{0,160}?\breturn\s+)?[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*\.querySelector\(\s*(?:\2|\3)\s*\)/gi,
    ),
  ]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  const rootTargets = [
    `["']${target}["']`,
    ...selectorHelpers.map((helper) => `${escapeRegExp(helper)}\\(\\s*["']${target}["']\\s*\\)`),
  ].join("|");
  if (
    new RegExp(
      `\\.(?:set|to)\\(\\s*(?:${rootTargets})\\s*,\\s*\\{[\\s\\S]{0,1000}?\\battr\\s*:\\s*\\{[\\s\\S]{0,500}?(?:["']${attribute}["']|${attribute})\\s*:\\s*["']${state}["']`,
      "i",
    ).test(script)
  ) {
    return true;
  }

  const variables = [
    ...script.matchAll(
      new RegExp(
        `\\b(?:const|let|var)\\s+([a-zA-Z_$][\\w$]*)\\s*=\\s*document\\.querySelector\\([^)]{0,240}?["']${target}["'][^)]{0,80}?\\)`,
        "gi",
      ),
    ),
    ...selectorHelpers.flatMap((helper) => [
      ...script.matchAll(
        new RegExp(
          `(?:\\b(?:const|let|var)\\s+|,\\s*)([a-zA-Z_$][\\w$]*)\\s*=\\s*${escapeRegExp(helper)}\\(\\s*["']${target}["']\\s*\\)`,
          "gi",
        ),
      ),
    ]),
  ]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  if (variables.length === 0) return false;

  const stateHelpers = [
    ...script.matchAll(
      /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*\(\s*([a-zA-Z_$][\w$]*)\s*,\s*([a-zA-Z_$][\w$]*)\s*\)\s*=>\s*\{[\s\S]{0,400}?\2\.dataset\.state\s*=\s*\3/gi,
    ),
  ]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));

  return variables.some((variable) => {
    const owner = escapeRegExp(variable);
    return (
      new RegExp(
        `\\.(?:set|to)\\(\\s*${owner}\\s*,\\s*\\{[\\s\\S]{0,1000}?\\battr\\s*:\\s*\\{[\\s\\S]{0,500}?(?:["']${attribute}["']|${attribute})\\s*:\\s*["']${state}["']`,
        "i",
      ).test(script) ||
      new RegExp(`${owner}\\.dataset\\.state\\s*=\\s*["']${state}["']`, "i").test(script) ||
      new RegExp(
        `${owner}\\.setAttribute\\(\\s*["']${attribute}["']\\s*,\\s*["']${state}["']`,
        "i",
      ).test(script) ||
      stateHelpers.some((helper) =>
        new RegExp(`\\b${escapeRegExp(helper)}\\(\\s*${owner}\\s*,\\s*["']${state}["']`, "i").test(
          script,
        ),
      )
    );
  });
}

function hasRootStateSelector(
  css: string,
  rootHfId: string,
  archetype: string,
  rootId: string | null,
  stateAttribute: string,
  stateId: string,
): boolean {
  const rootSelectors = [
    attributeSelector("data-hf-id", rootHfId),
    attributeSelector("data-component", archetype),
  ];
  if (rootId && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(rootId)) {
    rootSelectors.push(`#${escapeRegExp(rootId)}(?![a-zA-Z0-9_-])`);
  }
  const root = `(?:${rootSelectors.join("|")})`;
  const state = attributeSelector(stateAttribute, stateId);
  const compoundModifiers = `(?:\\.[a-zA-Z_][a-zA-Z0-9_-]*|\\[[^\\]{}]+\\]|:[a-zA-Z-]+(?:\\([^{}]*\\))?)*`;
  return cssRuleSelectors(css).some(
    (selector) =>
      new RegExp(`${root}${compoundModifiers}${state}`, "i").test(selector) ||
      new RegExp(`${state}${compoundModifiers}${root}`, "i").test(selector),
  );
}

function cssRuleSelectors(css: string): string[] {
  const selectors: string[] = [];
  const blockKinds: Array<"at-rule" | "rule"> = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") {
      const prelude = css.slice(start, index).trim();
      const kind = prelude.startsWith("@") ? "at-rule" : "rule";
      if (kind === "rule" && prelude) selectors.push(prelude);
      blockKinds.push(kind);
      start = index + 1;
      continue;
    }
    if (character === "}") {
      blockKinds.pop();
      start = index + 1;
      continue;
    }
    if (character === ";" && blockKinds.at(-1) !== "at-rule") {
      start = index + 1;
    }
  }
  return selectors;
}

function attributeSelector(attribute: string, value: string): string {
  return `\\[\\s*${escapeRegExp(attribute)}\\s*=\\s*(?:"${escapeRegExp(value)}"|'${escapeRegExp(value)}'|${escapeRegExp(value)})\\s*\\]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
