import { createHash } from "node:crypto";
import {
  LayoutClusterV1Schema,
  type LayoutClusterV1,
  type OverlapIntentV1,
  type QaFindingV1,
  type SequenceArtifactV1,
} from "../shared";

export const REPAIRABLE_LAYOUT_CODES = new Set([
  "content_overlap",
  "text_occluded",
  "container_overflow",
  "text_box_overflow",
  "clipped_text",
]);
const OVERFLOW_CODES = new Set(["container_overflow", "text_box_overflow", "clipped_text"]);
const MAX_LAYOUT_TIME = 3_600;

interface BeatOwnership {
  beatId: string;
  beatIndex: number;
  sourceFile: string;
  start: number | null;
  end: number | null;
  topEntityIds: readonly string[];
  partEntityIds: readonly string[];
}

interface LayoutObservation {
  finding: QaFindingV1;
  owner: BeatOwnership;
  selector: string | null;
  relatedSelector: string | null;
  timeRange: readonly [number, number];
  observationCount: number;
  sortKey: string;
}

/**
 * Collapses element-level HyperFrames layout findings into deterministic causal clusters.
 * This function is intentionally read-only: it neither suppresses QA nor edits a candidate.
 */
export function buildLayoutClusters(
  findings: readonly QaFindingV1[],
  sequence: SequenceArtifactV1,
): LayoutClusterV1[] {
  const ownership = buildOwnership(sequence);
  const observations = findings
    .flatMap((finding) => toObservations(finding, ownership))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey));

  const parents = observations.map((_, index) => index);
  for (let left = 0; left < observations.length; left += 1) {
    for (let right = left + 1; right < observations.length; right += 1) {
      const leftObservation = observations[left];
      const rightObservation = observations[right];
      if (!leftObservation || !rightObservation) continue;
      if (
        rangesOverlap(leftObservation.timeRange, rightObservation.timeRange) &&
        causallyRelated(leftObservation, rightObservation)
      ) {
        union(parents, left, right);
      }
    }
  }

  const components = new Map<number, LayoutObservation[]>();
  for (const [index, observation] of observations.entries()) {
    const root = findRoot(parents, index);
    const component = components.get(root) ?? [];
    component.push(observation);
    components.set(root, component);
  }

  return coalesceHandoffComponents([...components.values()])
    .map((component) => buildCluster(component, sequence))
    .sort(
      (left, right) =>
        left.sampleTime - right.sampleTime ||
        sequenceBeatIndex(sequence, left.beatIds[0]) -
          sequenceBeatIndex(sequence, right.beatIds[0]) ||
        left.id.localeCompare(right.id),
    );
}

export const clusterLayoutFindings = buildLayoutClusters;

export function isRepairableLayoutFinding(finding: QaFindingV1): boolean {
  return (
    finding.category === "layout" &&
    finding.severity !== "info" &&
    REPAIRABLE_LAYOUT_CODES.has(finding.code)
  );
}

/**
 * Finds one exact, beat-owned declaration for a cluster. Ambiguous or partial declarations
 * do not match, and matching alone does not decide whether the declared overlap is legible.
 */
export function matchNarrowOverlapIntent(
  cluster: LayoutClusterV1,
  sequence: SequenceArtifactV1,
): OverlapIntentV1 | null {
  if (cluster.kind === "overflow") return null;
  const semanticEntityIds = new Set(
    sequence.beats
      .filter((beat) => cluster.beatIds.includes(beat.id))
      .flatMap((beat) => beat.entities.flatMap((entity) => [entity.id, ...entity.parts])),
  );
  if (cluster.entityIds.some((entityId) => !semanticEntityIds.has(entityId))) return null;

  const expectedKind = cluster.kind === "handoff" ? "handoff" : "overlay";
  const matches = sequence.overlapIntents
    .filter(
      (intent) =>
        intent.kind === expectedKind &&
        intent.timeRange[0] <= cluster.timeRange[0] &&
        intent.timeRange[1] >= cluster.timeRange[1] &&
        sameStringSet(intent.entities, cluster.entityIds),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function buildOwnership(sequence: SequenceArtifactV1): BeatOwnership[] {
  return sequence.beats.flatMap((beat, beatIndex) =>
    beat.implementationFiles.map((sourceFile) => ({
      beatId: beat.id,
      beatIndex,
      sourceFile: normalizeProjectPath(sourceFile),
      start: beat.start ?? null,
      end:
        beat.start !== undefined && beat.duration !== undefined ? beat.start + beat.duration : null,
      topEntityIds: beat.entities.map((entity) => entity.id),
      partEntityIds: beat.entities.flatMap((entity) => entity.parts),
    })),
  );
}

function toObservations(
  finding: QaFindingV1,
  ownership: readonly BeatOwnership[],
): LayoutObservation[] {
  if (
    finding.category !== "layout" ||
    finding.severity === "info" ||
    !REPAIRABLE_LAYOUT_CODES.has(finding.code) ||
    finding.sourceFile === null
  ) {
    return [];
  }
  const selector = normalizeSelector(finding.selector);
  const relatedSelector = normalizeSelector(finding.geometry?.relatedSelector ?? null);
  if (selector === null && relatedSelector === null) return [];

  const measured = [...new Set(finding.times)]
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= MAX_LAYOUT_TIME)
    .sort((left, right) => left - right);
  const byOwner = new Map<string, { owner: BeatOwnership; times: number[] }>();
  for (const time of measured) {
    const owner = findOwnership(finding.sourceFile, [time, time], ownership);
    if (!owner) continue;
    const key = `${owner.beatIndex}\u0000${owner.sourceFile}`;
    const group = byOwner.get(key) ?? { owner, times: [] };
    group.times.push(time);
    byOwner.set(key, group);
  }
  const fullRange = findingTimeRange(finding);
  const boundaryOwners = fullRange
    ? semanticBoundaryOwners(
        finding.sourceFile,
        fullRange,
        [selector, relatedSelector, finding.identity?.hfId ?? null],
        ownership,
      )
    : [];
  if (boundaryOwners.length > 1 && fullRange) {
    return boundaryOwners.map((owner) =>
      layoutObservation(
        finding,
        owner,
        selector,
        relatedSelector,
        [
          Math.max(fullRange[0], owner.start ?? fullRange[0]),
          Math.min(fullRange[1], owner.end ?? fullRange[1]),
        ],
        1,
      ),
    );
  }
  if (byOwner.size > 0) {
    if (byOwner.size === 1) {
      const group = [...byOwner.values()][0]!;
      const ownedRange = fullRange ?? [group.times[0] ?? 0, group.times.at(-1) ?? 0];
      return [
        layoutObservation(
          finding,
          group.owner,
          selector,
          relatedSelector,
          ownedRange,
          finding.observationCount ?? group.times.length,
        ),
      ];
    }
    return [...byOwner.values()].map(({ owner, times }) =>
      layoutObservation(
        finding,
        owner,
        selector,
        relatedSelector,
        [times[0] ?? 0, times.at(-1) ?? times[0] ?? 0],
        times.length,
      ),
    );
  }

  const timeRange = findingTimeRange(finding);
  const owner = timeRange ? findOwnership(finding.sourceFile, timeRange, ownership) : null;
  if (!owner || !timeRange) return [];
  return [
    layoutObservation(
      finding,
      owner,
      selector,
      relatedSelector,
      timeRange,
      finding.observationCount ?? 1,
    ),
  ];
}

function layoutObservation(
  finding: QaFindingV1,
  owner: BeatOwnership,
  selector: string | null,
  relatedSelector: string | null,
  timeRange: readonly [number, number],
  observationCount: number,
): LayoutObservation {
  const sortKey = JSON.stringify({
    beatId: owner.beatId,
    code: finding.code,
    observationCount,
    relatedSelector,
    selector,
    sourceFile: owner.sourceFile,
    timeRange,
  });
  return {
    finding,
    owner,
    selector,
    relatedSelector,
    timeRange,
    observationCount,
    sortKey,
  };
}

function findOwnership(
  sourceFile: string,
  timeRange: readonly [number, number],
  ownership: readonly BeatOwnership[],
): BeatOwnership | null {
  const sourceMatches = matchingOwnership(sourceFile, ownership);
  if (sourceMatches.length <= 1) return sourceMatches[0] ?? null;

  const midpoint = (timeRange[0] + timeRange[1]) / 2;
  const measuredMatches = sourceMatches
    .map((candidate) => ({
      candidate,
      midpointOwned: ownsTime(candidate, midpoint),
      overlap: ownershipOverlap(candidate, timeRange),
    }))
    .filter((match) => match.overlap > 0 || match.midpointOwned)
    .sort(
      (left, right) =>
        right.overlap - left.overlap ||
        Number(right.midpointOwned) - Number(left.midpointOwned) ||
        right.candidate.beatIndex - left.candidate.beatIndex,
    );
  if (measuredMatches[0]) return measuredMatches[0].candidate;
  if (timeRange[0] === timeRange[1]) {
    return (
      sourceMatches
        .filter((candidate) => candidate.end === timeRange[0])
        .sort((left, right) => right.beatIndex - left.beatIndex)[0] ?? null
    );
  }
  return null;
}

function matchingOwnership(
  sourceFile: string,
  ownership: readonly BeatOwnership[],
): BeatOwnership[] {
  const normalizedSource = normalizeProjectPath(sourceFile).toLocaleLowerCase("en-US");
  return ownership.filter((candidate) => {
    const normalizedCandidate = candidate.sourceFile.toLocaleLowerCase("en-US");
    return (
      normalizedSource === normalizedCandidate ||
      normalizedSource.endsWith(`/${normalizedCandidate}`)
    );
  });
}

function semanticBoundaryOwners(
  sourceFile: string,
  timeRange: readonly [number, number],
  selectors: readonly (string | null)[],
  ownership: readonly BeatOwnership[],
): BeatOwnership[] {
  const mentioned = selectors.filter((selector): selector is string => selector !== null);
  if (mentioned.length === 0) return [];
  const matches = matchingOwnership(sourceFile, ownership).sort(
    (left, right) => left.beatIndex - right.beatIndex,
  );
  for (let index = 0; index < matches.length - 1; index += 1) {
    const outgoing = matches[index];
    const incoming = matches[index + 1];
    if (
      !outgoing ||
      !incoming ||
      outgoing.end === null ||
      incoming.start === null ||
      Math.abs(outgoing.end - incoming.start) > 0.001 ||
      outgoing.end < timeRange[0] - 0.001 ||
      outgoing.end > timeRange[1] + 0.001
    ) {
      continue;
    }
    const outgoingIds = [...outgoing.topEntityIds, ...outgoing.partEntityIds];
    const incomingIds = [...incoming.topEntityIds, ...incoming.partEntityIds];
    const mentionsOutgoing = outgoingIds.some((entityId) =>
      mentioned.some((selector) => selectorMentionsId(selector, entityId)),
    );
    const mentionsIncoming = incomingIds.some((entityId) =>
      mentioned.some((selector) => selectorMentionsId(selector, entityId)),
    );
    if (mentionsOutgoing && mentionsIncoming) return [outgoing, incoming];
  }
  return [];
}

function ownershipOverlap(owner: BeatOwnership, timeRange: readonly [number, number]): number {
  if (owner.start === null || owner.end === null) return 0;
  if (timeRange[0] === timeRange[1]) return ownsTime(owner, timeRange[0]) ? 1 : 0;
  return Math.max(0, Math.min(owner.end, timeRange[1]) - Math.max(owner.start, timeRange[0]));
}

function ownsTime(owner: BeatOwnership, time: number): boolean {
  if (owner.start === null || owner.end === null) return false;
  // Beat intervals are half-open. A finding sampled exactly on a boundary belongs
  // to the incoming beat, which is the state HyperFrames has just rendered.
  return time >= owner.start && time < owner.end;
}

function findingTimeRange(finding: QaFindingV1): readonly [number, number] | null {
  const points = [
    ...finding.times,
    finding.geometry?.firstSeen ?? Number.NaN,
    finding.geometry?.lastSeen ?? Number.NaN,
  ].filter((value) => Number.isFinite(value) && value >= 0 && value <= MAX_LAYOUT_TIME);
  if (points.length === 0) return null;
  return [Math.min(...points), Math.max(...points)];
}

function causallyRelated(left: LayoutObservation, right: LayoutObservation): boolean {
  const sameCoveringSelector =
    left.relatedSelector !== null && left.relatedSelector === right.relatedSelector;
  const coveringSelectorMatchesDescendant =
    (left.relatedSelector !== null && left.relatedSelector === right.selector) ||
    (right.relatedSelector !== null && right.relatedSelector === left.selector);
  return sameCoveringSelector || coveringSelectorMatchesDescendant;
}

function coalesceHandoffComponents(
  components: readonly LayoutObservation[][],
): LayoutObservation[][] {
  const parents = components.map((_, index) => index);
  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      const leftComponent = components[left];
      const rightComponent = components[right];
      if (
        leftComponent &&
        rightComponent &&
        describeBoundary(leftComponent) === describeBoundary(rightComponent) &&
        describeBoundary(leftComponent) !== null &&
        rangesOverlap(componentTimeRange(leftComponent), componentTimeRange(rightComponent))
      ) {
        union(parents, left, right);
      }
    }
  }

  const merged = new Map<number, LayoutObservation[]>();
  for (const [index, component] of components.entries()) {
    const root = findRoot(parents, index);
    const observations = merged.get(root) ?? [];
    observations.push(...component);
    merged.set(root, observations);
  }
  return [...merged.values()];
}

function describeBoundary(component: readonly LayoutObservation[]): string | null {
  const beatIds = unique(
    [...component]
      .sort((left, right) => left.owner.beatIndex - right.owner.beatIndex)
      .map((observation) => observation.owner.beatId),
  );
  return beatIds.length > 1 ? beatIds.join("\u0000") : null;
}

function componentTimeRange(component: readonly LayoutObservation[]): readonly [number, number] {
  return [
    Math.min(...component.map((observation) => observation.timeRange[0])),
    Math.max(...component.map((observation) => observation.timeRange[1])),
  ];
}

function rangesOverlap(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] <= right[1] && right[0] <= left[1];
}

function buildCluster(
  component: readonly LayoutObservation[],
  sequence: SequenceArtifactV1,
): LayoutClusterV1 {
  const observations = [...component].sort((left, right) =>
    left.sortKey.localeCompare(right.sortKey),
  );
  const beatIds = unique(
    observations
      .map((observation) => observation.owner)
      .sort((left, right) => left.beatIndex - right.beatIndex)
      .map((owner) => owner.beatId),
  );
  const sourceFiles = unique(
    observations
      .map((observation) => observation.owner)
      .sort(
        (left, right) =>
          left.beatIndex - right.beatIndex || left.sourceFile.localeCompare(right.sourceFile),
      )
      .map((owner) => owner.sourceFile),
  );
  const timeRange = [
    Math.min(...observations.map((observation) => observation.timeRange[0])),
    Math.max(...observations.map((observation) => observation.timeRange[1])),
  ] as const;
  const sampleTime = selectSampleTime(observations);
  const kind = observations.some((observation) => OVERFLOW_CODES.has(observation.finding.code))
    ? "overflow"
    : beatIds.length > 1
      ? "handoff"
      : observations.some((observation) => observation.finding.code === "text_occluded")
        ? "occlusion"
        : "overlap";
  const entityIds = clusterEntityIds(observations, sequence, beatIds);
  const findingKeys = unique(
    observations.map((observation) => layoutFindingKey(observation.finding)),
  );
  const fingerprint = JSON.stringify({
    version: "sequences.layout-cluster-fingerprint.v1",
    beatIds,
    entityIds,
    observations: observations.map((observation) => JSON.parse(observation.sortKey) as unknown),
    sourceFiles,
  });
  const id = `layout-cluster-${sha256(fingerprint).slice(0, 24)}`;
  const artifactRoot = `layout/clusters/${id}`;
  const findingCount = observations.length;
  const beatLabel = beatIds.join(" → ");
  const clusterLabel = kind === "handoff" ? `${beatLabel} handoff` : `${beatLabel} ${kind}`;
  const descendantLabel = findingCount === 1 ? "descendant" : "descendants";

  return LayoutClusterV1Schema.parse({
    id,
    kind,
    status: "undeclared",
    sampleTime,
    timeRange,
    findingCount,
    observationCount: observations.reduce(
      (total, observation) => total + observation.observationCount,
      0,
    ),
    beatIds,
    // Clustering runs before a rendered DOM exists. These are deterministic
    // implementation scopes; inspection records the authored DOM composition ID.
    compositionIds: sourceFiles.map(compositionScopeId),
    sourceFiles,
    entityIds,
    findingKeys,
    intentId: null,
    summary: `${clusterLabel} caused one unresolved layout cluster at ${formatTime(sampleTime)}s, affecting ${findingCount} ${descendantLabel}.`,
    artifacts: {
      inspection: `${artifactRoot}/inspection.json`,
      fullFrame: `${artifactRoot}/full-frame.png`,
      crop: `${artifactRoot}/crop.png`,
    },
  });
}

export function layoutFindingKey(finding: QaFindingV1): string {
  return sha256(
    JSON.stringify({
      category: finding.category,
      code: finding.code,
      command: finding.command,
      fixHint: finding.fixHint,
      identity: finding.identity?.hfId ?? null,
      message: finding.message,
      relatedSelector: normalizeSelector(finding.geometry?.relatedSelector ?? null),
      selector: normalizeSelector(finding.selector),
      severity: finding.severity,
      sourceFile: finding.sourceFile ? normalizeProjectPath(finding.sourceFile) : null,
    }),
  );
}

function selectSampleTime(observations: readonly LayoutObservation[]): number {
  const candidates = uniqueNumbers(
    observations.flatMap((observation) => [
      observation.timeRange[0],
      observation.timeRange[1],
      ...observation.finding.times,
    ]),
  ).sort((left, right) => left - right);
  let selected = candidates[0] ?? observations[0]?.timeRange[0] ?? 0;
  let selectedScore = -1;
  for (const candidate of candidates) {
    const score = observations.filter(
      (observation) =>
        candidate >= observation.timeRange[0] && candidate <= observation.timeRange[1],
    ).length;
    if (score > selectedScore) {
      selected = candidate;
      selectedScore = score;
    }
  }
  return selected;
}

function clusterEntityIds(
  observations: readonly LayoutObservation[],
  sequence: SequenceArtifactV1,
  beatIds: readonly string[],
): string[] {
  const ownedBeats = sequence.beats.filter((beat) => beatIds.includes(beat.id));
  const topEntityIds = unique(
    ownedBeats.flatMap((beat) => beat.entities.map((entity) => entity.id)),
  );
  const selectors = observations.flatMap((observation) =>
    [
      observation.selector,
      observation.relatedSelector,
      observation.finding.identity?.hfId ?? null,
    ].filter((value): value is string => value !== null),
  );
  const exactTopEntityIds = topEntityIds.filter((entityId) =>
    selectors.some((selector) => selectorMentionsId(selector, entityId)),
  );
  let entityIds = exactTopEntityIds.length >= 2 ? exactTopEntityIds : topEntityIds;

  if (entityIds.length < 2) {
    const partEntityIds = unique(
      ownedBeats.flatMap((beat) => beat.entities.flatMap((entity) => entity.parts)),
    );
    entityIds = unique([
      ...entityIds,
      ...partEntityIds.filter((entityId) =>
        selectors.some((selector) => selectorMentionsId(selector, entityId)),
      ),
      ...partEntityIds,
    ]);
  }
  if (entityIds.length < 2) {
    entityIds = unique(
      [
        ...entityIds,
        ...observations.flatMap((observation) => [
          observation.selector ? syntheticEntityId("primary", observation.selector) : null,
          observation.relatedSelector
            ? syntheticEntityId("related", observation.relatedSelector)
            : null,
        ]),
      ].filter((entityId): entityId is string => entityId !== null),
    );
  }
  if (entityIds.length < 2) {
    entityIds.push(syntheticEntityId("peer", observations[0]?.sortKey ?? "layout-peer"));
  }
  return unique(entityIds).slice(0, 100);
}

function selectorMentionsId(selector: string, entityId: string): boolean {
  const escaped = entityId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`, "i").test(selector);
}

function syntheticEntityId(role: string, value: string): string {
  return `layout-${role}-${sha256(value).slice(0, 16)}`;
}

function normalizeProjectPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

function compositionScopeId(sourceFile: string): string {
  const normalized = normalizeProjectPath(sourceFile);
  const fileName = normalized.split("/").at(-1) ?? normalized;
  const stem = fileName.replace(/\.[^.]+$/, "");
  const slug = stem
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return /^[a-z]/.test(slug) ? slug : `composition-${slug || sha256(normalized).slice(0, 12)}`;
}

function normalizeSelector(value: string | null): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ") ?? "";
  return normalized.length > 0 ? normalized : null;
}

function formatTime(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function sequenceBeatIndex(sequence: SequenceArtifactV1, beatId: string | undefined): number {
  const index = beatId ? sequence.beats.findIndex((beat) => beat.id === beatId) : -1;
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value)))];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function findRoot(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) root = parents[root] ?? root;
  while (parents[index] !== index) {
    const next = parents[index] ?? root;
    parents[index] = root;
    index = next;
  }
  return root;
}

function union(parents: number[], left: number, right: number): void {
  const leftRoot = findRoot(parents, left);
  const rightRoot = findRoot(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}
