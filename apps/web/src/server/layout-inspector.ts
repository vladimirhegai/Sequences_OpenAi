import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import {
  closeCaptureSession,
  createCaptureSession,
  createFileServer,
  injectDeterministicFontFaces,
  type CaptureSession,
  type FileServerHandle,
} from "@hyperframes/producer";
import {
  LayoutInspectionV1Schema,
  type LayoutClusterV1,
  type LayoutInspectionV1,
  type LayoutRectV1,
  type QaFindingV1,
  type SequenceArtifactV1,
} from "../shared";

const MAX_BROWSER_ENTITIES = 40;
const GRID_SIZE = 8;
const DEFAULT_TIMEOUT_MS = 30_000;
const BUNDLED_ENTRY = ".sequences-layout-inspection.html";

export interface InspectLayoutClusterOptions {
  /** A disposable copy of the candidate. Bundling may only write here. */
  qaWorkspaceRoot: string;
  /** Filesystem root under which the cluster's declared artifacts are written. */
  artifactRoot: string;
  /** Run-relative prefix returned to callers, for example `qa/attempt-1`. */
  artifactPathPrefix: string;
  cluster: LayoutClusterV1;
  findings: readonly QaFindingV1[];
  sequence: SequenceArtifactV1;
  timeoutMs?: number;
}

export interface InspectLayoutClusterResult {
  inspection: LayoutInspectionV1;
  artifacts: LayoutClusterV1["artifacts"];
}

type BrowserLocator = {
  findingIndex: number;
  hfId: string | null;
  selector: string | null;
  allowContainment: boolean;
  bbox: LayoutRectV1 | null;
  relatedSelector: string | null;
  relatedBbox: LayoutRectV1 | null;
  sourceFile: string | null;
  compositionId: string | null;
};

type BrowserRect = LayoutRectV1 & { area: number };

type RawEntity = {
  role: "primary" | "peer";
  findingIndex: number;
  hfId: string | null;
  selector: string;
  compositionId: string | null;
  sourceFile: string | null;
  bbox: BrowserRect;
  localOpacity: number;
  effectiveOpacity: number;
  zIndex: number | "auto";
  stackingContexts: string[];
  parentContentBox: BrowserRect;
  lineBoxes: BrowserRect[];
  hasReadableText: boolean;
  readable: boolean;
};

type RawGuide = {
  id: string;
  kind: "grid" | "edge" | "center" | "baseline" | "safe-area";
  axis: "x" | "y";
  position: number;
  distance: number;
  roles: Array<RawEntity["role"]>;
};

type RawInspection = {
  canvas: BrowserRect;
  safeArea: BrowserRect;
  primary: RawEntity;
  peer: RawEntity;
  intersection: { bbox: BrowserRect; area: number; percent: number };
  guides: RawGuide[];
  availableRegions: Array<{ id: string; bbox: BrowserRect; area: number }>;
  suggestedPositions: Array<{
    role: RawEntity["role"];
    bbox: BrowserRect;
    guideIds: string[];
    reason: string;
  }>;
  policyViolations: Array<{
    code: string;
    severity: "warning" | "error";
    roles: Array<RawEntity["role"]>;
    message: string;
  }>;
};

type BrowserInspectInput = {
  compositionIds: string[];
  sourceFiles: string[];
  locators: BrowserLocator[];
  maxEntities: number;
  gridSize: number;
};

/**
 * Capture one unresolved layout cluster without mutating the authored candidate.
 * The bundled entry is written into the disposable QA copy; evidence is written
 * only to the cluster's bounded artifact paths.
 */
export async function inspectLayoutCluster(
  options: InspectLayoutClusterOptions,
): Promise<InspectLayoutClusterResult> {
  const qaWorkspaceRoot = resolve(options.qaWorkspaceRoot);
  const artifactRoot = resolve(options.artifactRoot);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await assertDirectory(qaWorkspaceRoot, "QA workspace");
  await mkdir(artifactRoot, { recursive: true });

  const outputPaths = {
    inspection: resolveArtifact(artifactRoot, options.cluster.artifacts.inspection),
    fullFrame: resolveArtifact(artifactRoot, options.cluster.artifacts.fullFrame),
    crop: resolveArtifact(artifactRoot, options.cluster.artifacts.crop),
  };
  await Promise.all(
    Object.values(outputPaths).map((path) => mkdir(dirname(path), { recursive: true })),
  );

  const bundled = await bundleToSingleHtml(qaWorkspaceRoot, { runtime: "inline" });
  const deterministicHtml = await injectDeterministicFontFaces(bundled);
  const bundledEntry = resolve(qaWorkspaceRoot, BUNDLED_ENTRY);
  await writeFile(bundledEntry, deterministicHtml, "utf8");

  const { width, height, fps } = compositionMetrics(deterministicHtml);
  const fileServer = await createLayoutFileServer({
    projectDir: qaWorkspaceRoot,
    fps,
  });
  let session: CaptureSession | null = null;
  try {
    session = await createCaptureSession(`${fileServer.url}/${BUNDLED_ENTRY}`, artifactRoot, {
      width,
      height,
      fps,
      format: "png",
      deviceScaleFactor: 2,
      captureBeyondViewport: false,
    });
    await session.page.goto(`${fileServer.url}/${BUNDLED_ENTRY}`, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await session.page.waitForFunction(
      () =>
        Boolean(
          window.__renderReady &&
          window.__player &&
          typeof window.__player.renderSeek === "function",
        ),
      { timeout: timeoutMs },
    );
    await session.page.evaluate(async (sampleTime) => {
      const player = window.__player;
      if (!player || typeof player.renderSeek !== "function") {
        throw new Error("HyperFrames player is not render-ready");
      }
      await player.renderSeek(sampleTime);
      await document.fonts.ready;
    }, options.cluster.sampleTime);

    const raw = await session.page.evaluate(collectBrowserInspection, {
      compositionIds: [...options.cluster.compositionIds],
      sourceFiles: [...options.cluster.sourceFiles],
      locators: findingLocators(options.findings),
      maxEntities: MAX_BROWSER_ENTITIES,
      gridSize: GRID_SIZE,
    } satisfies BrowserInspectInput);
    const inspection = materializeInspection(raw, options.cluster, options.sequence);

    await session.page.evaluate(drawBrowserAnnotations, raw);
    await session.page.screenshot({
      path: outputPaths.fullFrame,
      type: "png",
      captureBeyondViewport: false,
    });
    await session.page.screenshot({
      path: outputPaths.crop,
      type: "png",
      clip: focusedCrop(raw.primary.bbox, raw.peer.bbox, raw.canvas),
      captureBeyondViewport: false,
    });
    await writeFile(outputPaths.inspection, `${JSON.stringify(inspection, null, 2)}\n`, "utf8");

    return {
      inspection,
      artifacts: {
        inspection: prefixLayoutArtifactPath(
          options.artifactPathPrefix,
          options.cluster.artifacts.inspection,
        ),
        fullFrame: prefixLayoutArtifactPath(
          options.artifactPathPrefix,
          options.cluster.artifacts.fullFrame,
        ),
        crop: prefixLayoutArtifactPath(options.artifactPathPrefix, options.cluster.artifacts.crop),
      },
    };
  } finally {
    await closeBrowserResources(session, fileServer);
  }
}

/**
 * @hyperframes/producer serves capture files through @hono/node-server. That
 * adapter temporarily replaces the process-wide Request and Response globals
 * with its Node-optimized lightweight wrappers. Sequences itself is served by
 * Bun, which rejects those wrappers and falls back to its "Welcome to Bun"
 * response. Restore Bun's globals immediately after the producer starts its
 * private server; the Node adapter also accepts native web Responses.
 */
export function createLayoutFileServer(
  options: Parameters<typeof createFileServer>[0],
  start: typeof createFileServer = createFileServer,
): Promise<FileServerHandle> {
  const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Request");
  const responseDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Response");
  try {
    return start(options);
  } finally {
    restoreGlobal("Request", requestDescriptor);
    restoreGlobal("Response", responseDescriptor);
  }
}

function restoreGlobal(
  key: "Request" | "Response",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

function findingLocators(findings: readonly QaFindingV1[]): BrowserLocator[] {
  return findings.slice(0, MAX_BROWSER_ENTITIES).map((finding, findingIndex) => ({
    findingIndex,
    hfId: finding.identity?.hfId ?? null,
    selector: finding.selector,
    allowContainment: allowsContainedLayoutPeer(finding.code),
    bbox: finding.geometry?.bbox ?? null,
    relatedSelector: finding.geometry?.relatedSelector ?? null,
    relatedBbox: finding.geometry?.relatedBbox ?? null,
    sourceFile: finding.sourceFile,
    // A sequence beat is a semantic time range, not a DOM composition. The
    // browser resolves the authored composition ID from the rendered element.
    compositionId: null,
  }));
}

/** Overflow evidence intentionally relates a child to its clipping ancestor. */
export function allowsContainedLayoutPeer(code: string): boolean {
  return code === "container_overflow" || code === "text_box_overflow" || code === "clipped_text";
}

/**
 * Returns true only when the pinned HyperFrames finding identifies two
 * actionable layout entities (or a measured occlusion). The browser inspector
 * enriches that evidence; it must not manufacture a second blocker when the
 * raw detector reported only one/self-referential overflow box.
 */
export function hasActionableRawLayoutPair(findings: readonly QaFindingV1[]): boolean {
  return findings.some((finding) => {
    const geometry = finding.geometry;
    if (!geometry) return false;

    if (
      finding.code === "text_occluded" &&
      geometry.coveredFraction !== null &&
      geometry.coveredFraction > 0 &&
      hasPositiveLayoutRect(geometry.bbox)
    ) {
      return true;
    }

    if (hasPositiveLayoutRect(geometry.bbox) && hasPositiveLayoutRect(geometry.relatedBbox)) {
      return intersectLayoutRects(geometry.bbox, geometry.relatedBbox) !== null;
    }

    const primary = normalizeLocator(finding.selector);
    const related = normalizeLocator(geometry.relatedSelector);
    return (
      hasPositiveLayoutRect(geometry.bbox) &&
      primary !== null &&
      related !== null &&
      primary !== related
    );
  });
}

function hasPositiveLayoutRect(rect: LayoutRectV1 | null): rect is LayoutRectV1 {
  return rect !== null && rect.width > 0 && rect.height > 0;
}

function normalizeLocator(value: string | null): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized || null;
}

function materializeInspection(
  raw: RawInspection,
  cluster: LayoutClusterV1,
  sequence: SequenceArtifactV1,
): LayoutInspectionV1 {
  const rawEntities = [raw.primary, raw.peer] as const;
  const ownership = assignLayoutInspectionOwnership(rawEntities, cluster, sequence);
  const roleId = new Map(
    rawEntities.map((entity, index) => [entity.role, ownership[index]!.entityId]),
  );

  return LayoutInspectionV1Schema.parse({
    clusterId: cluster.id,
    sampleTime: cluster.sampleTime,
    canvas: stripArea(raw.canvas),
    safeArea: stripArea(raw.safeArea),
    grid: {
      columns: 12,
      rows: 8,
      columnGap: GRID_SIZE,
      rowGap: GRID_SIZE,
      margin: Math.max(0, raw.safeArea.left - raw.canvas.left),
    },
    entities: rawEntities.map((entity, index) => {
      const owner = ownership[index]!;
      return {
        identity: {
          beatId: owner.beatId,
          compositionId: owner.compositionId,
          entityId: owner.entityId,
          hfId: entity.hfId,
          selector: entity.selector,
        },
        bbox: stripArea(entity.bbox),
        // The contract carries one opacity value. Use the ancestor-product so
        // Luna receives the actual painted opacity, not merely the local CSS value.
        opacity: entity.effectiveOpacity,
        zIndex: entity.zIndex,
        stackingContexts: entity.stackingContexts,
        parentContentBox: stripArea(entity.parentContentBox),
        lineBoxes: entity.lineBoxes.map(stripArea),
        readabilityOwner: entity.hasReadableText ? owner.entityId : null,
        readable: entity.readable,
      };
    }),
    intersections: [
      {
        entityIds: [ownership[0]!.entityId, ownership[1]!.entityId],
        bbox: stripArea(raw.intersection.bbox),
        area: raw.intersection.area,
        percent: raw.intersection.percent,
      },
    ],
    guides: raw.guides.map((guide) => ({
      id: guide.id,
      kind: guide.kind,
      axis: guide.axis,
      position: guide.position,
      distance: guide.distance,
      entityIds: guide.roles.map((role) => roleId.get(role)!).filter(Boolean),
    })),
    availableRegions: raw.availableRegions.map((region) => ({
      id: region.id,
      bbox: stripArea(region.bbox),
      area: region.area,
    })),
    suggestedPositions: raw.suggestedPositions.map((position) => ({
      entityId: roleId.get(position.role)!,
      bbox: stripArea(position.bbox),
      guideIds: position.guideIds,
      reason: position.reason,
    })),
    policyViolations: raw.policyViolations.map((violation) => ({
      code: violation.code,
      severity: violation.severity,
      entityIds: violation.roles.map((role) => roleId.get(role)!).filter(Boolean),
      message: violation.message,
    })),
  });
}

export interface LayoutOwnershipObservation {
  compositionId: string | null;
  sourceFile: string | null;
  hfId: string | null;
}

export interface LayoutInspectionOwnership {
  beatId: string;
  compositionId: string;
  entityId: string;
}

export function assignLayoutInspectionOwnership(
  entities: readonly LayoutOwnershipObservation[],
  cluster: LayoutClusterV1,
  sequence: SequenceArtifactV1,
): LayoutInspectionOwnership[] {
  const used = new Set<string>();
  return entities.map((entity, index) => {
    const candidates = cluster.entityIds.filter((id) => !used.has(id));
    const clusterBeats = sequence.beats.filter((beat) => cluster.beatIds.includes(beat.id));
    const sourceOwnedBeats = clusterBeats.filter(
      (beat) =>
        entity.sourceFile !== null &&
        beat.implementationFiles.some((file) =>
          entity.sourceFile!.replaceAll("\\", "/").endsWith(file),
        ),
    );
    const timedSourceBeat = sourceOwnedBeats.find(
      (beat) =>
        beat.start !== undefined &&
        beat.duration !== undefined &&
        cluster.sampleTime >= beat.start &&
        cluster.sampleTime < beat.start + beat.duration,
    );
    const endingSourceBeat = [...sourceOwnedBeats]
      .reverse()
      .find(
        (beat) =>
          beat.start !== undefined &&
          beat.duration !== undefined &&
          cluster.sampleTime === beat.start + beat.duration,
      );
    const semanticBeats = clusterBeats.filter((beat) =>
      beat.entities.some(
        (candidate) =>
          candidates.includes(candidate.id) &&
          (candidate.id === entity.hfId || candidate.parts.includes(entity.hfId ?? "")),
      ),
    );
    const semanticBeat = semanticBeats.length === 1 ? semanticBeats[0] : undefined;
    const owningBeat =
      semanticBeat ??
      (sourceOwnedBeats.length === 1 ? sourceOwnedBeats[0] : (timedSourceBeat ?? endingSourceBeat));
    const matchingSequenceEntity = owningBeat?.entities.find(
      (candidate) =>
        candidates.includes(candidate.id) &&
        (candidate.id === entity.hfId || candidate.parts.includes(entity.hfId ?? "")),
    );
    const beatOwnedCandidates =
      owningBeat?.entities
        .filter((candidate) => candidates.includes(candidate.id))
        .map((candidate) => candidate.id) ?? [];
    const entityId =
      matchingSequenceEntity?.id ??
      beatOwnedCandidates[0] ??
      candidates.find((candidate) => candidate === entity.hfId) ??
      candidates[0] ??
      cluster.entityIds[index]!;
    used.add(entityId);

    const resolvedBeat =
      owningBeat ??
      sequence.beats.find(
        (beat) =>
          cluster.beatIds.includes(beat.id) &&
          beat.entities.some(
            (candidate) => candidate.id === entityId || candidate.parts.includes(entity.hfId ?? ""),
          ),
      );
    const beatId =
      resolvedBeat?.id ?? cluster.beatIds[Math.min(index, cluster.beatIds.length - 1)]!;
    const compositionId =
      entity.compositionId ??
      cluster.compositionIds[Math.min(index, cluster.compositionIds.length - 1)] ??
      cluster.compositionIds[0]!;
    return { beatId, compositionId, entityId };
  });
}

function stripArea(rect: BrowserRect): LayoutRectV1 {
  const { left, top, right, bottom, width, height } = rect;
  return { left, top, right, bottom, width, height };
}

export function intersectLayoutRects(
  first: LayoutRectV1,
  second: LayoutRectV1,
): { bbox: LayoutRectV1; area: number; percent: number } | null {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  if (right <= left || bottom <= top) return null;
  const width = right - left;
  const height = bottom - top;
  const area = width * height;
  const smallerArea = Math.min(first.width * first.height, second.width * second.height);
  return {
    bbox: { left, top, right, bottom, width, height },
    area,
    percent: smallerArea > 0 ? Math.min(100, (area / smallerArea) * 100) : 0,
  };
}

export function snapLayoutCoordinate(value: number, gridSize = GRID_SIZE): number {
  return Math.round(value / gridSize) * gridSize;
}

function focusedCrop(first: BrowserRect, second: BrowserRect, canvas: BrowserRect) {
  const padding = 64;
  const left = Math.max(canvas.left, Math.min(first.left, second.left) - padding);
  const top = Math.max(canvas.top, Math.min(first.top, second.top) - padding);
  const right = Math.min(canvas.right, Math.max(first.right, second.right) + padding);
  const bottom = Math.min(canvas.bottom, Math.max(first.bottom, second.bottom) + padding);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export function prefixLayoutArtifactPath(prefix: string, artifact: string): string {
  const cleanPrefix = normalizeRelativePath(prefix, true);
  const cleanArtifact = normalizeRelativePath(artifact, false);
  return cleanPrefix ? `${cleanPrefix}/${cleanArtifact}` : cleanArtifact;
}

function resolveArtifact(root: string, artifact: string): string {
  const normalized = normalizeRelativePath(artifact, false);
  const target = resolve(root, ...normalized.split("/"));
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === "" || resolve(root) === target) {
    throw new Error(`Layout artifact escaped its managed root: ${artifact}`);
  }
  return target;
}

function normalizeRelativePath(path: string, allowEmpty: boolean): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    if (allowEmpty) return "";
    throw new Error("Layout artifact path is empty or invalid");
  }
  if (normalized.includes("\0")) throw new Error("Layout artifact path is empty or invalid");
  if (normalized.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw new Error(`Layout artifact path contains traversal: ${path}`);
  }
  return normalized;
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const result = await stat(path);
  if (!result.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

async function closeBrowserResources(
  session: CaptureSession | null,
  fileServer: FileServerHandle,
): Promise<void> {
  try {
    if (session) await closeCaptureSession(session);
  } finally {
    fileServer.close();
  }
}

function compositionMetrics(html: string): {
  width: number;
  height: number;
  fps: { num: number; den: number };
} {
  const attribute = (name: string) => {
    const match = html.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
    return match?.[1] ?? null;
  };
  const boundedInteger = (value: string | null, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 8_192
      ? Math.round(parsed)
      : fallback;
  };
  const fpsNumber = boundedInteger(attribute("data-fps"), 30);
  return {
    width: boundedInteger(attribute("data-width"), 1_920),
    height: boundedInteger(attribute("data-height"), 1_080),
    fps: { num: fpsNumber, den: 1 },
  };
}

function collectBrowserInspection(input: BrowserInspectInput): RawInspection {
  const rect = (source: DOMRect | LayoutRectV1): BrowserRect => {
    const left = Number(source.left);
    const top = Number(source.top);
    const right = Number(source.right);
    const bottom = Number(source.bottom);
    const width = Math.max(0, Number(source.width));
    const height = Math.max(0, Number(source.height));
    return { left, top, right, bottom, width, height, area: width * height };
  };
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0
    );
  };
  const safeQuery = (root: ParentNode, selector: string | null): Element[] => {
    if (!selector) return [];
    try {
      return Array.from(root.querySelectorAll(selector)).slice(0, input.maxEntities);
    } catch {
      return [];
    }
  };
  const sourceRoots = input.sourceFiles
    .flatMap((sourceFile) => [
      ...safeQuery(document, `[data-composition-file="${CSS.escape(sourceFile)}"]`),
      ...safeQuery(document, `[data-composition-src="${CSS.escape(sourceFile)}"]`),
    ])
    .filter((element, index, all) => all.indexOf(element) === index);
  const compositionRoots = input.compositionIds
    .flatMap((compositionId) => [
      ...safeQuery(document, `[data-composition-id="${CSS.escape(compositionId)}"]`),
      ...safeQuery(document, `[data-hf-authored-id="${CSS.escape(compositionId)}"]`),
    ])
    .filter((element, index, all) => all.indexOf(element) === index);
  const scopeRoots = sourceRoots.length > 0 ? sourceRoots : compositionRoots;
  if (scopeRoots.length === 0) {
    const root = document.querySelector("[data-composition-id]") ?? document.body;
    scopeRoots.push(root);
  }
  const queryWithin = (roots: readonly Element[], selector: string | null) =>
    roots
      .flatMap((scope) => safeQuery(scope, selector))
      .filter((element, index, all) => visible(element) && all.indexOf(element) === index)
      .slice(0, input.maxEntities);
  const queryScoped = (selector: string | null) => queryWithin(scopeRoots, selector);
  const rootsForLocator = (locator: BrowserLocator) => {
    if (locator.sourceFile) {
      const normalizedSource = locator.sourceFile.replaceAll("\\", "/");
      const roots = scopeRoots.filter((scope) =>
        [scope.getAttribute("data-composition-file"), scope.getAttribute("data-composition-src")]
          .filter((value): value is string => value !== null)
          .some((value) => {
            const normalizedValue = value.replaceAll("\\", "/");
            return (
              normalizedSource === normalizedValue ||
              normalizedSource.endsWith(`/${normalizedValue}`)
            );
          }),
      );
      if (roots.length > 0) return roots;
    }
    if (!locator.compositionId) return scopeRoots;
    const roots = scopeRoots.filter(
      (scope) =>
        scope.getAttribute("data-composition-id") === locator.compositionId ||
        scope.getAttribute("data-hf-authored-id") === locator.compositionId,
    );
    return roots.length > 0 ? roots : scopeRoots;
  };
  const byHfId = (hfId: string | null, roots: readonly Element[] = scopeRoots) => {
    if (!hfId) return [];
    return queryWithin(roots, `[data-hf-id="${CSS.escape(hfId)}"]`);
  };
  const byBox = (box: LayoutRectV1 | null, roots: readonly Element[] = scopeRoots) => {
    if (!box) return [];
    const points = [
      [(box.left + box.right) / 2, (box.top + box.bottom) / 2],
      [box.left + 1, box.top + 1],
      [box.right - 1, box.bottom - 1],
    ] as const;
    return points
      .flatMap(([x, y]) => document.elementsFromPoint(x, y))
      .filter(
        (element, index, all) =>
          roots.some((root) => root === element || root.contains(element)) &&
          visible(element) &&
          all.indexOf(element) === index,
      )
      .slice(0, input.maxEntities);
  };
  const overlap = (first: Element, second: Element) => {
    const a = first.getBoundingClientRect();
    const b = second.getBoundingClientRect();
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
  };
  const resolvePrimary = (locator: BrowserLocator) => {
    const roots = rootsForLocator(locator);
    return (
      byHfId(locator.hfId, roots)[0] ??
      queryWithin(roots, locator.selector)[0] ??
      byBox(locator.bbox, roots)[0] ??
      null
    );
  };
  const resolvePeer = (locator: BrowserLocator, primary: Element) => {
    const candidates = [
      ...queryScoped(locator.relatedSelector),
      ...byBox(locator.relatedBbox),
    ].filter(
      (candidate, index, all) =>
        candidate !== primary &&
        (locator.allowContainment ||
          (!candidate.contains(primary) && !primary.contains(candidate))) &&
        all.indexOf(candidate) === index,
    );
    return (
      candidates.sort((first, second) => overlap(primary, second) - overlap(primary, first))[0] ??
      null
    );
  };

  const resolved = input.locators
    .map((locator) => {
      const primary = resolvePrimary(locator);
      if (!primary) return null;
      const peer = resolvePeer(locator, primary);
      return peer ? { locator, primary, peer, area: overlap(primary, peer) } : null;
    })
    .filter((pair): pair is NonNullable<typeof pair> => pair !== null && pair.area > 0)
    .sort((first, second) => second.area - first.area);

  if (resolved.length === 0) {
    const primaries = input.locators
      .map((locator) => ({ locator, element: resolvePrimary(locator) }))
      .filter(
        (entry): entry is { locator: BrowserLocator; element: Element } => entry.element !== null,
      )
      .slice(0, input.maxEntities);
    for (let firstIndex = 0; firstIndex < primaries.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < primaries.length; secondIndex += 1) {
        const first = primaries[firstIndex]!;
        const second = primaries[secondIndex]!;
        const area = overlap(first.element, second.element);
        if (area > 0) {
          resolved.push({
            locator: first.locator,
            primary: first.element,
            peer: second.element,
            area,
          });
        }
      }
    }
    resolved.sort((first, second) => second.area - first.area);
  }
  const selected = resolved[0];
  if (!selected) {
    throw new Error("No intersecting entity pair could be resolved for the layout cluster");
  }

  const cssPath = (element: Element) => {
    const id = element.getAttribute("data-hf-id");
    if (id) return `[data-hf-id="${CSS.escape(id)}"]`;
    if (element.id) return `#${CSS.escape(element.id)}`;
    const segments: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement && segments.length < 6) {
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (sibling) => sibling.tagName === current!.tagName,
          )
        : [];
      const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      segments.unshift(`${current.tagName.toLowerCase()}${suffix}`);
      if (scopeRoots.includes(current)) break;
      current = current.parentElement;
    }
    return segments.join(" > ") || element.tagName.toLowerCase();
  };
  const sourceOwner = (element: Element) => {
    const owner = element.closest("[data-composition-file], [data-composition-src]");
    return (
      owner?.getAttribute("data-composition-file") ??
      owner?.getAttribute("data-composition-src") ??
      null
    );
  };
  const compositionOwner = (element: Element) => {
    const owner = element.closest("[data-composition-id], [data-hf-authored-id]");
    return (
      owner?.getAttribute("data-composition-id") ??
      owner?.getAttribute("data-hf-authored-id") ??
      null
    );
  };
  const contentBox = (element: Element | null): BrowserRect => {
    if (!element) return rect(new DOMRect(0, 0, innerWidth, innerHeight));
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const left = box.left + (Number.parseFloat(style.paddingLeft) || 0);
    const top = box.top + (Number.parseFloat(style.paddingTop) || 0);
    const right = box.right - (Number.parseFloat(style.paddingRight) || 0);
    const bottom = box.bottom - (Number.parseFloat(style.paddingBottom) || 0);
    return rect({
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    });
  };
  const stackingContexts = (element: Element) => {
    const contexts: string[] = [];
    let current: Element | null = element;
    while (current && contexts.length < 30) {
      const style = getComputedStyle(current);
      const reasons: string[] = [];
      if (current === document.documentElement) reasons.push("root");
      if (style.position !== "static" && style.zIndex !== "auto")
        reasons.push(`z-index:${style.zIndex}`);
      if (Number(style.opacity) < 1) reasons.push(`opacity:${style.opacity}`);
      if (style.transform !== "none") reasons.push("transform");
      if (style.filter !== "none") reasons.push("filter");
      if (style.perspective !== "none") reasons.push("perspective");
      if (style.isolation === "isolate") reasons.push("isolation");
      if (style.mixBlendMode !== "normal") reasons.push(`blend:${style.mixBlendMode}`);
      if (/paint|layout/.test(style.contain)) reasons.push(`contain:${style.contain}`);
      if (reasons.length > 0) contexts.push(`${cssPath(current)} (${reasons.join(", ")})`);
      current = current.parentElement;
    }
    return contexts;
  };
  const lineBoxes = (element: Element) => {
    const boxes: BrowserRect[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && boxes.length < 200) {
      if (node.textContent?.trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const box of Array.from(range.getClientRects())) {
          if (box.width > 0 && box.height > 0) boxes.push(rect(box));
          if (boxes.length >= 200) break;
        }
      }
      node = walker.nextNode();
    }
    return boxes;
  };
  const effectiveOpacity = (element: Element) => {
    let product = 1;
    let current: Element | null = element;
    while (current) {
      product *= Math.max(0, Math.min(1, Number(getComputedStyle(current).opacity) || 0));
      current = current.parentElement;
    }
    return product;
  };
  const readableAtLines = (element: Element, boxes: BrowserRect[], opacity: number) => {
    if (boxes.length === 0) return opacity > 0.05;
    let visibleSamples = 0;
    for (const box of boxes) {
      const top = document.elementsFromPoint(
        (box.left + box.right) / 2,
        (box.top + box.bottom) / 2,
      )[0];
      if (top && (element === top || element.contains(top))) visibleSamples += 1;
    }
    return opacity > 0.05 && visibleSamples / boxes.length >= 0.5;
  };
  const measureEntity = (
    role: RawEntity["role"],
    element: Element,
    findingIndex: number,
  ): RawEntity => {
    const style = getComputedStyle(element);
    const lines = lineBoxes(element);
    const paintedOpacity = effectiveOpacity(element);
    const parsedZ = Number.parseInt(style.zIndex, 10);
    return {
      role,
      findingIndex,
      hfId: element.getAttribute("data-hf-id"),
      selector: cssPath(element),
      compositionId: compositionOwner(element),
      sourceFile: sourceOwner(element),
      bbox: rect(element.getBoundingClientRect()),
      localOpacity: Math.max(0, Math.min(1, Number(style.opacity) || 0)),
      effectiveOpacity: paintedOpacity,
      zIndex: style.zIndex === "auto" || !Number.isFinite(parsedZ) ? "auto" : parsedZ,
      stackingContexts: stackingContexts(element),
      parentContentBox: contentBox(element.parentElement),
      lineBoxes: lines,
      hasReadableText: Boolean(element.textContent?.trim()) && lines.length > 0,
      readable: readableAtLines(element, lines, paintedOpacity),
    };
  };

  const primary = measureEntity("primary", selected.primary, selected.locator.findingIndex);
  const peer = measureEntity("peer", selected.peer, selected.locator.findingIndex);
  const left = Math.max(primary.bbox.left, peer.bbox.left);
  const top = Math.max(primary.bbox.top, peer.bbox.top);
  const right = Math.min(primary.bbox.right, peer.bbox.right);
  const bottom = Math.min(primary.bbox.bottom, peer.bbox.bottom);
  const intersectionBox = rect({
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  });
  if (intersectionBox.area <= 0) throw new Error("Resolved layout entities do not intersect");

  const canvas = rect(new DOMRect(0, 0, innerWidth, innerHeight));
  const topScope =
    scopeRoots.find((scope) => scope.getBoundingClientRect().width > 0) ?? scopeRoots[0]!;
  const scopedContent = contentBox(topScope);
  const hasAuthoredSafePadding =
    scopedContent.left > canvas.left ||
    scopedContent.top > canvas.top ||
    scopedContent.right < canvas.right ||
    scopedContent.bottom < canvas.bottom;
  const safeArea = hasAuthoredSafePadding
    ? rect({
        left: Math.max(canvas.left, scopedContent.left),
        top: Math.max(canvas.top, scopedContent.top),
        right: Math.min(canvas.right, scopedContent.right),
        bottom: Math.min(canvas.bottom, scopedContent.bottom),
        width: Math.max(
          0,
          Math.min(canvas.right, scopedContent.right) - Math.max(canvas.left, scopedContent.left),
        ),
        height: Math.max(
          0,
          Math.min(canvas.bottom, scopedContent.bottom) - Math.max(canvas.top, scopedContent.top),
        ),
      })
    : rect({
        left: canvas.width * 0.05,
        top: canvas.height * 0.05,
        right: canvas.width * 0.95,
        bottom: canvas.height * 0.95,
        width: canvas.width * 0.9,
        height: canvas.height * 0.9,
      });

  const observed = Array.from(
    new Set<Element>([
      selected.primary,
      selected.peer,
      ...scopeRoots.flatMap((scope) => safeQuery(scope, "[data-hf-id]")),
    ]),
  )
    .filter((element) => visible(element))
    .slice(0, input.maxEntities);
  const blockers = observed
    .filter(
      (element) =>
        element !== selected.primary &&
        element !== selected.peer &&
        !element.contains(selected.primary) &&
        !element.contains(selected.peer),
    )
    .map((element) => rect(element.getBoundingClientRect()));

  const union = rect({
    left: Math.min(primary.bbox.left, peer.bbox.left),
    top: Math.min(primary.bbox.top, peer.bbox.top),
    right: Math.max(primary.bbox.right, peer.bbox.right),
    bottom: Math.max(primary.bbox.bottom, peer.bbox.bottom),
    width:
      Math.max(primary.bbox.right, peer.bbox.right) - Math.min(primary.bbox.left, peer.bbox.left),
    height:
      Math.max(primary.bbox.bottom, peer.bbox.bottom) - Math.min(primary.bbox.top, peer.bbox.top),
  });
  const intersects = (first: BrowserRect, second: BrowserRect) =>
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top;
  const largestFreePart = (initial: BrowserRect) => {
    let current = initial;
    for (const blocker of blockers) {
      if (!intersects(current, blocker)) continue;
      const choices = [
        rect({
          left: current.left,
          top: current.top,
          right: Math.min(current.right, blocker.left),
          bottom: current.bottom,
          width: Math.max(0, Math.min(current.right, blocker.left) - current.left),
          height: current.height,
        }),
        rect({
          left: Math.max(current.left, blocker.right),
          top: current.top,
          right: current.right,
          bottom: current.bottom,
          width: Math.max(0, current.right - Math.max(current.left, blocker.right)),
          height: current.height,
        }),
        rect({
          left: current.left,
          top: current.top,
          right: current.right,
          bottom: Math.min(current.bottom, blocker.top),
          width: current.width,
          height: Math.max(0, Math.min(current.bottom, blocker.top) - current.top),
        }),
        rect({
          left: current.left,
          top: Math.max(current.top, blocker.bottom),
          right: current.right,
          bottom: current.bottom,
          width: current.width,
          height: Math.max(0, current.bottom - Math.max(current.top, blocker.bottom)),
        }),
      ].filter((candidate) => candidate.area > 0);
      current = choices.sort((first, second) => second.area - first.area)[0] ?? current;
    }
    return current;
  };
  const candidates = [
    {
      id: "region-left",
      box: rect({
        left: safeArea.left,
        top: safeArea.top,
        right: Math.min(safeArea.right, union.left),
        bottom: safeArea.bottom,
        width: Math.max(0, Math.min(safeArea.right, union.left) - safeArea.left),
        height: safeArea.height,
      }),
    },
    {
      id: "region-right",
      box: rect({
        left: Math.max(safeArea.left, union.right),
        top: safeArea.top,
        right: safeArea.right,
        bottom: safeArea.bottom,
        width: Math.max(0, safeArea.right - Math.max(safeArea.left, union.right)),
        height: safeArea.height,
      }),
    },
    {
      id: "region-above",
      box: rect({
        left: safeArea.left,
        top: safeArea.top,
        right: safeArea.right,
        bottom: Math.min(safeArea.bottom, union.top),
        width: safeArea.width,
        height: Math.max(0, Math.min(safeArea.bottom, union.top) - safeArea.top),
      }),
    },
    {
      id: "region-below",
      box: rect({
        left: safeArea.left,
        top: Math.max(safeArea.top, union.bottom),
        right: safeArea.right,
        bottom: safeArea.bottom,
        width: safeArea.width,
        height: Math.max(0, safeArea.bottom - Math.max(safeArea.top, union.bottom)),
      }),
    },
  ];
  const availableRegions = candidates
    .map(({ id, box }) => ({ id, bbox: largestFreePart(box) }))
    .filter(({ bbox }) => bbox.width >= input.gridSize && bbox.height >= input.gridSize)
    .map(({ id, bbox }) => ({ id, bbox, area: bbox.area }));

  const guideCandidates: RawGuide[] = [];
  const addNearestGuides = (entity: RawEntity) => {
    const axisCandidates = [
      {
        kind: "safe-area" as const,
        axis: "x" as const,
        position: safeArea.left,
        value: entity.bbox.left,
        suffix: "safe-left",
      },
      {
        kind: "safe-area" as const,
        axis: "x" as const,
        position: safeArea.right,
        value: entity.bbox.right,
        suffix: "safe-right",
      },
      {
        kind: "center" as const,
        axis: "x" as const,
        position: (safeArea.left + safeArea.right) / 2,
        value: (entity.bbox.left + entity.bbox.right) / 2,
        suffix: "safe-center-x",
      },
      {
        kind: "safe-area" as const,
        axis: "y" as const,
        position: safeArea.top,
        value: entity.bbox.top,
        suffix: "safe-top",
      },
      {
        kind: "safe-area" as const,
        axis: "y" as const,
        position: safeArea.bottom,
        value: entity.bbox.bottom,
        suffix: "safe-bottom",
      },
      {
        kind: "center" as const,
        axis: "y" as const,
        position: (safeArea.top + safeArea.bottom) / 2,
        value: (entity.bbox.top + entity.bbox.bottom) / 2,
        suffix: "safe-center-y",
      },
      {
        kind: "grid" as const,
        axis: "x" as const,
        position: Math.round(entity.bbox.left / input.gridSize) * input.gridSize,
        value: entity.bbox.left,
        suffix: "grid-x",
      },
      {
        kind: "grid" as const,
        axis: "y" as const,
        position: Math.round(entity.bbox.top / input.gridSize) * input.gridSize,
        value: entity.bbox.top,
        suffix: "grid-y",
      },
    ];
    for (const axis of ["x", "y"] as const) {
      guideCandidates.push(
        ...axisCandidates
          .filter((candidate) => candidate.axis === axis)
          .sort(
            (first, second) =>
              Math.abs(first.position - first.value) - Math.abs(second.position - second.value),
          )
          .slice(0, 3)
          .map((candidate) => ({
            id: `guide-${entity.role}-${candidate.suffix}`,
            kind: candidate.kind,
            axis: candidate.axis,
            position: candidate.position,
            distance: Math.abs(candidate.position - candidate.value),
            roles: [entity.role],
          })),
      );
    }
  };
  addNearestGuides(primary);
  addNearestGuides(peer);

  const suggestedPositions = ([primary, peer] as const).flatMap((entity) => {
    const region = availableRegions
      .filter(({ bbox }) => bbox.width >= entity.bbox.width && bbox.height >= entity.bbox.height)
      .sort((first, second) => second.area - first.area)[0];
    if (!region) return [];
    const snappedLeft = Math.round(region.bbox.left / input.gridSize) * input.gridSize;
    const snappedTop = Math.round(region.bbox.top / input.gridSize) * input.gridSize;
    const left = Math.min(
      region.bbox.right - entity.bbox.width,
      Math.max(region.bbox.left, snappedLeft),
    );
    const top = Math.min(
      region.bbox.bottom - entity.bbox.height,
      Math.max(region.bbox.top, snappedTop),
    );
    const bbox = rect({
      left,
      top,
      right: left + entity.bbox.width,
      bottom: top + entity.bbox.height,
      width: entity.bbox.width,
      height: entity.bbox.height,
    });
    return [
      {
        role: entity.role,
        bbox,
        guideIds: [`guide-${entity.role}-grid-x`, `guide-${entity.role}-grid-y`],
        reason: `Move ${entity.role} into ${region.id} on the ${input.gridSize}px placement grid.`,
      },
    ];
  });

  const policyViolations = safeQuery(
    document,
    "[data-layout-allow-overlap], [data-layout-allow-occlusion]",
  )
    .slice(0, input.maxEntities)
    .flatMap((element) => {
      const box = rect(element.getBoundingClientRect());
      const broad =
        element === document.documentElement ||
        element === document.body ||
        element.id === "root" ||
        element.classList.contains("scene") ||
        element.hasAttribute("data-composition-src") ||
        element.hasAttribute("data-composition-id") ||
        (canvas.area > 0 && box.area / canvas.area > 0.6);
      if (!broad) return [];
      const marker = element.hasAttribute("data-layout-allow-occlusion") ? "occlusion" : "overlap";
      const roles = ([primary, peer] as const)
        .filter(
          (entity) =>
            entity.selector === cssPath(element) ||
            element.contains(entity.role === "primary" ? selected.primary : selected.peer),
        )
        .map((entity) => entity.role);
      return [
        {
          code: `broad-${marker}-suppression`,
          severity: "error" as const,
          roles,
          message: `${cssPath(element)} applies data-layout-allow-${marker} to a root, scene, composition host, or container covering more than 60% of the canvas.`,
        },
      ];
    });

  return {
    canvas,
    safeArea,
    primary,
    peer,
    intersection: {
      bbox: intersectionBox,
      area: intersectionBox.area,
      percent: Math.min(
        100,
        (intersectionBox.area / Math.min(primary.bbox.area, peer.bbox.area)) * 100,
      ),
    },
    guides: guideCandidates,
    availableRegions,
    suggestedPositions,
    policyViolations,
  };
}

function drawBrowserAnnotations(raw: RawInspection): void {
  document.getElementById("sequences-layout-inspection-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "sequences-layout-inspection-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    fontFamily: "Inter, Arial, sans-serif",
  });
  const addBox = (
    box: LayoutRectV1,
    color: string,
    label: string,
    style: "solid" | "dashed" = "solid",
  ) => {
    const node = document.createElement("div");
    Object.assign(node.style, {
      position: "absolute",
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      boxSizing: "border-box",
      border: `3px ${style} ${color}`,
      background: style === "solid" ? `${color}18` : "transparent",
    });
    const tag = document.createElement("span");
    tag.textContent = label;
    Object.assign(tag.style, {
      position: "absolute",
      left: "0",
      top: "0",
      transform: "translateY(-100%)",
      padding: "4px 7px",
      borderRadius: "4px 4px 0 0",
      color: "white",
      background: color,
      fontSize: "14px",
      fontWeight: "700",
      lineHeight: "1.2",
      whiteSpace: "nowrap",
    });
    node.append(tag);
    overlay.append(node);
  };
  addBox(raw.safeArea, "#06b6d4", "safe area", "dashed");
  addBox(raw.primary.bbox, "#ef4444", `primary · ${raw.primary.hfId ?? raw.primary.selector}`);
  addBox(raw.peer.bbox, "#3b82f6", `peer · ${raw.peer.hfId ?? raw.peer.selector}`);
  addBox(raw.intersection.bbox, "#f59e0b", `${raw.intersection.percent.toFixed(1)}% overlap`);
  for (const guide of raw.guides) {
    const line = document.createElement("div");
    Object.assign(line.style, {
      position: "absolute",
      left: guide.axis === "x" ? `${guide.position}px` : "0",
      top: guide.axis === "y" ? `${guide.position}px` : "0",
      width: guide.axis === "x" ? "0" : "100%",
      height: guide.axis === "y" ? "0" : "100%",
      borderLeft: guide.axis === "x" ? "1px dashed rgba(255,255,255,.6)" : "none",
      borderTop: guide.axis === "y" ? "1px dashed rgba(255,255,255,.6)" : "none",
    });
    overlay.append(line);
  }
  document.body.append(overlay);
}

declare global {
  interface Window {
    __renderReady?: boolean;
    __player?: {
      renderSeek: (time: number) => void | Promise<void>;
    };
  }
}
