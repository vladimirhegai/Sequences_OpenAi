import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  LayoutRectV1Schema,
  MAX_QA_RECEIPT_FINDINGS,
  QaReceiptV1Schema,
  type LayoutClusterV1,
  type LayoutInspectionV1,
  type QaFindingV1,
  type QaReceiptV1,
  type SequenceArtifactV1,
} from "../shared";
import type { ServerConfig } from "./config";
import { errorMessage } from "./errors";
import { isWithin } from "./files";
import {
  clusterLayoutFindings,
  isRepairableLayoutFinding,
  layoutFindingKey,
  matchNarrowOverlapIntent,
} from "./layout-clusters";
import { hasActionableRawLayoutPair, inspectLayoutCluster } from "./layout-inspector";
import {
  scanOverlapPolicy,
  stripOverlapSuppressionMarkers,
  type OverlapPolicyScan,
} from "./overlap-policy";
import {
  isolatedToolEnvironment,
  startProcess,
  type ProcessResult,
  type RunningProcess,
} from "./process-runner";

const LintEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  })
  .passthrough();

const CheckEnvelopeSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();

type LayoutClusterInspector = typeof inspectLayoutCluster;

export interface TemporalSnapshotCapture {
  evidenceImages: string[];
  evidenceImagePaths: string[];
  times: number[];
}

const QaFindingObservationSchema = z
  .object({
    code: z.string().min(1).max(160),
    severity: z.enum(["error", "warning", "info"]),
    time: z.number().finite().nonnegative().optional(),
    sourceFile: z.string().min(1).max(300).optional(),
    selector: z.string().min(1).max(1_000).optional(),
    message: z.string().min(1).max(2_000),
    text: z.string().max(2_000).optional(),
    fixHint: z.string().min(1).max(2_000).nullable().optional(),
    fg: z.string().min(1).max(80).optional(),
    bg: z.string().min(1).max(80).optional(),
    ratio: z.number().finite().positive().optional(),
    requiredRatio: z.number().finite().positive().optional(),
    suggestedColor: z.string().min(1).max(80).nullable().optional(),
    dataAttributes: z.record(z.string(), z.string()).optional(),
    rect: LayoutRectV1Schema.nullable().optional(),
    bbox: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative(),
      })
      .nullable()
      .optional(),
    containerSelector: z.string().min(1).max(1_000).optional(),
    coveredFraction: z.number().finite().min(0).max(1).optional(),
    firstSeen: z.number().finite().nonnegative().optional(),
    lastSeen: z.number().finite().nonnegative().optional(),
    occurrences: z.number().int().positive().optional(),
  })
  .passthrough();

export class HyperframesVerifier {
  private readonly active = new Map<string, RunningProcess>();

  constructor(
    private readonly config: ServerConfig,
    private readonly inspectCluster: LayoutClusterInspector = inspectLayoutCluster,
  ) {}

  async verify(
    jobId: string,
    candidateRoot: string,
    runRoot: string,
    options: { artifactDirectory?: string; sequence?: SequenceArtifactV1 } = {},
  ): Promise<QaReceiptV1> {
    const qaRoot = resolve(runRoot, "qa-workspace");
    if (!isWithin(runRoot, qaRoot) || relative(runRoot, qaRoot) !== "qa-workspace") {
      throw new Error("QA workspace escaped its managed run directory");
    }
    try {
      await cp(candidateRoot, qaRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (source) =>
          ![".git", ".agents", ".env"].includes(source.split(/[\\/]/).at(-1) ?? ""),
      });
      const artifactDirectory = options.artifactDirectory ?? "";
      if (artifactDirectory && !/^qa\/attempt-[1-9]$/.test(artifactDirectory)) {
        throw new Error("QA artifact directory is outside the bounded attempt ledger");
      }
      const artifactRoot = artifactDirectory ? resolve(runRoot, artifactDirectory) : runRoot;
      if (!isWithin(runRoot, artifactRoot) && resolve(runRoot) !== artifactRoot) {
        throw new Error("QA artifacts escaped the managed run directory");
      }
      await mkdir(artifactRoot, { recursive: true });
      const artifactPath = (name: string) =>
        artifactDirectory ? `${artifactDirectory}/${name}` : name;
      let overlapPolicy: OverlapPolicyScan = { markers: [], violations: [] };
      if (options.sequence) {
        overlapPolicy = await scanOverlapPolicy(candidateRoot, options.sequence);
        const strippedMarkers = await stripOverlapSuppressionMarkers(qaRoot);
        await writeFile(
          join(artifactRoot, "layout-policy.json"),
          `${JSON.stringify({ ...overlapPolicy, strippedMarkers }, null, 2)}\n`,
          "utf8",
        );
      }
      const toolTempRoot = join(runRoot, "tmp");
      await mkdir(toolTempRoot, { recursive: true });
      const env = isolatedToolEnvironment(jobId, toolTempRoot);
      const cliEntry = join(
        this.config.workspaceRoot,
        "node_modules",
        "hyperframes",
        "dist",
        "cli.js",
      );
      const version = await this.command(jobId, [cliEntry, "--version"], qaRoot, env, 10_000);
      if (version.exitCode !== 0 || version.stdout.trim() !== "0.7.56") {
        throw new Error(
          `Expected Hyperframes 0.7.56; received ${version.stdout.trim() || version.stderr.trim() || "no version"}`,
        );
      }

      const commands: QaReceiptV1["commands"] = [];
      const findings: QaFindingV1[] = [];
      let rawCheckReport: unknown = null;
      const lint = await this.command(
        jobId,
        [cliEntry, "lint", qaRoot, "--json"],
        qaRoot,
        env,
        2 * 60 * 1_000,
      );
      await writeFile(join(artifactRoot, "lint.json"), lint.stdout, "utf8");
      await writeFile(
        join(artifactRoot, "lint.stderr.log"),
        lint.stderr.slice(0, 256 * 1_024),
        "utf8",
      );
      const lintReport = parseReport(lint.stdout, LintEnvelopeSchema, "lint");
      const lintParsed = lintReport.envelope;
      findings.push(...normalizeQaFindings("lint", lintReport.report, artifactPath("lint.json")));
      const lintOk = lint.exitCode === 0 && lintParsed.errorCount === 0;
      commands.push({
        command: "lint",
        ok: lintOk,
        exitCode: lint.exitCode ?? -1,
        durationMs: lint.durationMs,
        errorCount: lintParsed.errorCount,
        warningCount: lintParsed.warningCount,
        artifact: artifactPath("lint.json"),
        ...(!lintOk ? { error: summarizeFailure(lint, "Hyperframes lint reported errors") } : {}),
      });

      if (lintOk) {
        const check = await this.command(
          jobId,
          [
            cliEntry,
            "check",
            qaRoot,
            "--json",
            "--strict",
            "--snapshots",
            "--at-transitions",
            "--frame-check",
          ],
          qaRoot,
          env,
          5 * 60 * 1_000,
        );
        await writeFile(join(artifactRoot, "check.json"), check.stdout, "utf8");
        await writeFile(
          join(artifactRoot, "check.stderr.log"),
          check.stderr.slice(0, 256 * 1_024),
          "utf8",
        );
        const checkReport = parseReport(check.stdout, CheckEnvelopeSchema, "check");
        rawCheckReport = checkReport.report;
        const checkParsed = checkReport.envelope;
        findings.push(
          ...normalizeQaFindings("check", checkReport.report, artifactPath("check.json")),
        );
        const checkOk = check.exitCode === 0 && checkParsed.ok;
        commands.push({
          command: "check",
          ok: checkOk,
          exitCode: check.exitCode ?? -1,
          durationMs: check.durationMs,
          artifact: artifactPath("check.json"),
          ...(!checkOk ? { error: summarizeFailure(check, "Hyperframes check failed") } : {}),
        });
        try {
          if ((await stat(join(qaRoot, "snapshots"))).isDirectory()) {
            await rename(join(qaRoot, "snapshots"), join(artifactRoot, "snapshots"));
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }

      for (const violation of overlapPolicy.violations) {
        findings.push({
          command: "check",
          category: "layout_policy",
          code: violation.code,
          severity: "error",
          sourceFile: violation.sourceFile,
          selector: violation.identity ? `[data-hf-id="${violation.identity}"]` : null,
          times: [],
          message: violation.message,
          fixHint: "Remove the broad marker or bind it to one exact semantic overlap intent.",
          ...(violation.identity ? { identity: { hfId: violation.identity } } : {}),
          artifact: artifactPath("layout-policy.json"),
        });
      }

      let layoutClusters: LayoutClusterV1[] = [];
      if (options.sequence && rawCheckReport) {
        const clustered = clusterLayoutFindings(findings, options.sequence);
        layoutClusters = [];
        for (const cluster of clustered) {
          const clusterFindings = findingsForClusterInspection(findings, cluster);
          try {
            const inspected = await this.inspectCluster({
              qaWorkspaceRoot: qaRoot,
              artifactRoot,
              artifactPathPrefix: artifactDirectory,
              cluster,
              findings: clusterFindings,
              sequence: options.sequence,
            });
            layoutClusters.push(
              adjudicateLayoutCluster(
                { ...cluster, artifacts: inspected.artifacts },
                inspected.inspection,
                options.sequence,
                overlapPolicy,
              ),
            );
          } catch (error) {
            // Keep the raw blocking cluster repairable even when the richer
            // browser inspection cannot resolve an entity pair. The original
            // HyperFrames finding geometry and snapshots still provide enough
            // bounded evidence for Luna to correct overflow/placement. Dropping
            // the cluster here makes the repair loop terminate early.
            layoutClusters.push(cluster);
            findings.push(
              layoutInspectionFailure(cluster, clusterFindings, error, artifactPath("check.json")),
            );
          }
        }
      }

      const adjudicated = canAdjudicateLayoutFailure(
        commands,
        findings,
        layoutClusters,
        rawCheckReport,
        overlapPolicy,
      );
      const summary = summarizeQaFindings(findings);
      const receiptFindings = boundQaReceiptFindings(findings);
      if (receiptFindings.length < findings.length) {
        await writeFile(
          join(artifactRoot, "findings.full.json"),
          `${JSON.stringify(findings, null, 2)}\n`,
          "utf8",
        );
      }

      const receipt = QaReceiptV1Schema.parse({
        version: "sequences.qa-receipt.v1",
        hyperframesVersion: "0.7.56",
        ok:
          commands.length === 2 &&
          commands[0]?.ok === true &&
          ((commands[1]?.ok === true && summary.errorCount === 0) || adjudicated),
        commands,
        summary,
        findings: receiptFindings,
        layoutClusters,
        adjudicated,
      });
      await writeFile(
        join(artifactRoot, "qa.json"),
        `${JSON.stringify(receipt, null, 2)}\n`,
        "utf8",
      );
      if (artifactRoot !== runRoot) {
        await writeFile(join(runRoot, "qa.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      }
      return receipt;
    } finally {
      await this.removeQaWorkspace(runRoot, qaRoot);
    }
  }

  async captureTemporalSnapshots(
    jobId: string,
    candidateRoot: string,
    runRoot: string,
    times: readonly number[],
  ): Promise<TemporalSnapshotCapture> {
    const exactTimes = [...new Set(times.map((time) => Math.round(time * 1_000) / 1_000))];
    if (
      exactTimes.length === 0 ||
      exactTimes.length > 40 ||
      exactTimes.some((time) => !Number.isFinite(time) || time < 0)
    ) {
      throw new Error("Temporal snapshot timestamps must contain 1..40 finite nonnegative values");
    }
    const workspaceRoot = resolve(runRoot, "temporal-workspace");
    const workflowRoot = resolve(runRoot, "workflow");
    const outputRoot = resolve(workflowRoot, "temporal-snapshots");
    if (
      !isWithin(runRoot, workspaceRoot) ||
      relative(runRoot, workspaceRoot) !== "temporal-workspace" ||
      !isWithin(runRoot, outputRoot) ||
      relative(runRoot, outputRoot) !== join("workflow", "temporal-snapshots")
    ) {
      throw new Error("Temporal snapshot workspace escaped its managed run directory");
    }

    await mkdir(workflowRoot, { recursive: true });
    await mkdir(outputRoot);
    try {
      await cp(candidateRoot, workspaceRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (source) =>
          ![".git", ".agents", ".env"].includes(source.split(/[\\/]/).at(-1) ?? ""),
      });
      const toolTempRoot = join(runRoot, "tmp");
      await mkdir(toolTempRoot, { recursive: true });
      const env = isolatedToolEnvironment(jobId, toolTempRoot);
      const cliEntry = join(
        this.config.workspaceRoot,
        "node_modules",
        "hyperframes",
        "dist",
        "cli.js",
      );
      const captured = await this.command(
        jobId,
        [
          cliEntry,
          "snapshot",
          workspaceRoot,
          "--output",
          outputRoot,
          "--at",
          exactTimes.join(","),
          "--no-end",
          "--describe",
          "false",
        ],
        workspaceRoot,
        env,
        5 * 60 * 1_000,
      );
      await writeFile(
        join(workflowRoot, "temporal-snapshots.stdout.log"),
        captured.stdout.slice(0, 256 * 1_024),
        "utf8",
      );
      await writeFile(
        join(workflowRoot, "temporal-snapshots.stderr.log"),
        captured.stderr.slice(0, 256 * 1_024),
        "utf8",
      );
      if (captured.exitCode !== 0) {
        throw new Error(summarizeFailure(captured, "Hyperframes temporal snapshot capture failed"));
      }
      const pngNames = (await readdir(outputRoot))
        .filter((name) => /^frame-\d+-at-\d+(?:\.\d+)?s\.png$/i.test(name))
        .sort();
      if (pngNames.length !== exactTimes.length) {
        throw new Error(
          `Hyperframes captured ${pngNames.length}/${exactTimes.length} requested temporal snapshots`,
        );
      }

      const evidenceImages: string[] = [];
      const evidenceImagePaths: string[] = [];
      for (const [index, time] of exactTimes.entries()) {
        const canonicalName = `frame-${String(index).padStart(2, "0")}-at-${time.toFixed(3)}s.png`;
        const canonicalPath = join(outputRoot, canonicalName);
        await rename(join(outputRoot, pngNames[index]!), canonicalPath);
        evidenceImages.push(relative(runRoot, canonicalPath).replace(/\\/g, "/"));
        evidenceImagePaths.push(canonicalPath);
      }
      return { evidenceImages, evidenceImagePaths, times: exactTimes };
    } finally {
      await this.removeManagedWorkspace(runRoot, workspaceRoot);
    }
  }

  private async command(
    jobId: string,
    args: readonly string[],
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<ProcessResult> {
    const processHandle = startProcess({
      executable: this.config.hyperframesCommand,
      args,
      cwd,
      env,
      timeoutMs,
      maxStdoutBytes: 16 * 1_024 * 1_024,
      maxStderrBytes: 256 * 1_024,
    });
    this.active.set(jobId, processHandle);
    try {
      return await processHandle.result;
    } finally {
      this.active.delete(jobId);
    }
  }

  cancel(jobId: string): boolean {
    const running = this.active.get(jobId);
    if (!running) return false;
    running.cancel();
    return true;
  }

  private async removeQaWorkspace(runRoot: string, qaRoot: string): Promise<void> {
    await this.removeManagedWorkspace(runRoot, qaRoot);
  }

  private async removeManagedWorkspace(runRoot: string, workspaceRoot: string): Promise<void> {
    if (!isWithin(runRoot, workspaceRoot) || resolve(runRoot) === resolve(workspaceRoot)) {
      throw new Error("Refusing to remove an unmanaged tool workspace");
    }
    try {
      await rm(workspaceRoot, { recursive: true, force: false });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function parseReport<T extends z.ZodTypeAny>(
  stdout: string,
  schema: T,
  command: string,
): { envelope: z.output<T>; report: unknown } {
  try {
    const report = JSON.parse(stdout) as unknown;
    return { envelope: schema.parse(report), report };
  } catch (error) {
    throw new Error(
      `Hyperframes ${command} returned an invalid pinned JSON envelope: ${errorMessage(error)}`,
    );
  }
}

export function normalizeQaFindings(
  command: "lint" | "check",
  report: unknown,
  artifact = `${command}.json`,
): QaFindingV1[] {
  return normalizeQaFindingsWithAccounting(command, report, artifact).findings;
}

interface NormalizedQaFindingsWithAccounting {
  findings: QaFindingV1[];
  rawErrorFindings: QaFindingV1[];
  demotedRawErrorCount: number;
  invalidRawErrorCount: number;
}

function normalizeQaFindingsWithAccounting(
  command: "lint" | "check",
  report: unknown,
  artifact = `${command}.json`,
): NormalizedQaFindingsWithAccounting {
  const groups = new Map<string, QaFindingV1>();
  const structuralInnerRoots = new Map<string, boolean>();
  const fullCanvasStructuralInnerRoots = new Map<string, boolean>();
  const rawErrorKeys = new Set<string>();
  let invalidRawErrorCount = 0;
  for (const { category, finding } of qaFindingObservations(report, command)) {
    const parsed = QaFindingObservationSchema.safeParse(finding);
    if (!parsed.success) {
      if (isRecord(finding) && finding.severity === "error") invalidRawErrorCount += 1;
      continue;
    }
    const sourceFile = normalizeSourceFile(parsed.data.sourceFile) ?? null;
    const selector = parsed.data.selector ?? null;
    const fixHint = parsed.data.fixHint ?? null;
    const key = [
      command,
      category,
      parsed.data.code,
      parsed.data.severity,
      sourceFile ?? "",
      selector ?? "",
      parsed.data.message,
      fixHint ?? "",
    ].join("\u0000");
    if (parsed.data.severity === "error") rawErrorKeys.add(key);
    const current = groups.get(key);
    if (current) {
      structuralInnerRoots.set(
        key,
        structuralInnerRoots.get(key) === true &&
          parsed.data.dataAttributes?.["data-hf-inner-root"] === "true",
      );
      fullCanvasStructuralInnerRoots.set(
        key,
        fullCanvasStructuralInnerRoots.get(key) === true &&
          isFullCanvasStructuralInnerRoot(parsed.data),
      );
      if (parsed.data.time !== undefined && !current.times.includes(parsed.data.time)) {
        current.times.push(parsed.data.time);
      }
      const sample = contrastSample(parsed.data);
      if (sample && current.contrast && !hasContrastSample(current.contrast.samples, sample)) {
        current.contrast.samples.push(sample);
      }
      if (current.observationCount !== undefined) current.observationCount += 1;
      if (current.geometry) {
        current.geometry.firstSeen = minimumNullable(
          current.geometry.firstSeen,
          parsed.data.firstSeen ?? parsed.data.time ?? null,
        );
        current.geometry.lastSeen = maximumNullable(
          current.geometry.lastSeen,
          parsed.data.lastSeen ?? parsed.data.time ?? null,
        );
        current.geometry.occurrences = Math.max(
          current.geometry.occurrences,
          parsed.data.occurrences ?? 1,
        );
      }
      continue;
    }
    const sample = contrastSample(parsed.data);
    const hfId = parsed.data.dataAttributes?.["data-hf-id"] ?? null;
    const geometry = layoutGeometry(parsed.data);
    groups.set(key, {
      command,
      category,
      code: parsed.data.code,
      severity: parsed.data.severity,
      sourceFile,
      selector,
      times: parsed.data.time === undefined ? [] : [parsed.data.time],
      message: parsed.data.message,
      ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
      fixHint,
      ...(hfId ? { identity: { hfId } } : {}),
      ...(geometry ? { observationCount: 1, geometry } : {}),
      ...(sample ? { contrast: { samples: [sample] } } : {}),
      artifact,
    });
    structuralInnerRoots.set(key, parsed.data.dataAttributes?.["data-hf-inner-root"] === "true");
    fullCanvasStructuralInnerRoots.set(key, isFullCanvasStructuralInnerRoot(parsed.data));
  }
  let demotedRawErrorCount = 0;
  const entries = [...groups.entries()].map(([key, finding]) => {
    const demoted = shouldDemoteLayoutFinding(
      finding,
      structuralInnerRoots.get(key) === true,
      fullCanvasStructuralInnerRoots.get(key) === true,
    );
    if (demoted && rawErrorKeys.has(key)) demotedRawErrorCount += 1;
    return {
      key,
      finding: {
        ...finding,
        severity: demoted ? ("info" as const) : finding.severity,
        times: boundedObservationTimes(finding.times),
      },
    };
  });
  entries.sort((left, right) => {
    const severity = severityRank(left.finding.severity) - severityRank(right.finding.severity);
    if (severity !== 0) return severity;
    return `${left.finding.category}:${left.finding.sourceFile ?? ""}:${left.finding.selector ?? ""}`.localeCompare(
      `${right.finding.category}:${right.finding.sourceFile ?? ""}:${right.finding.selector ?? ""}`,
    );
  });
  return {
    findings: entries.map((entry) => entry.finding),
    rawErrorFindings: entries
      .filter((entry) => rawErrorKeys.has(entry.key))
      .map((entry) => entry.finding),
    demotedRawErrorCount,
    invalidRawErrorCount,
  };
}

function boundedObservationTimes(times: readonly number[], maximum = 30): number[] {
  const sorted = [...new Set(times)].sort((left, right) => left - right);
  if (sorted.length <= maximum) return sorted;
  const sampled: number[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round((index * (sorted.length - 1)) / (maximum - 1));
    const time = sorted[sourceIndex];
    if (time !== undefined && sampled.at(-1) !== time) sampled.push(time);
  }
  return sampled;
}

export function boundQaReceiptFindings(
  findings: readonly QaFindingV1[],
  maximum = MAX_QA_RECEIPT_FINDINGS,
): QaFindingV1[] {
  if (findings.length <= maximum) return [...findings];
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => {
      const severity = severityRank(left.finding.severity) - severityRank(right.finding.severity);
      if (severity !== 0) return severity;
      const identity = (entry: QaFindingV1): string =>
        [
          entry.command,
          entry.category,
          entry.code,
          entry.sourceFile ?? "",
          entry.selector ?? "",
          entry.message,
        ].join("\u0000");
      return (
        identity(left.finding).localeCompare(identity(right.finding)) || left.index - right.index
      );
    })
    .slice(0, maximum)
    .map((entry) => entry.finding);
}

function layoutGeometry(
  finding: z.infer<typeof QaFindingObservationSchema>,
): QaFindingV1["geometry"] | null {
  if (
    !finding.rect &&
    !finding.bbox &&
    !finding.containerSelector &&
    finding.firstSeen === undefined &&
    finding.lastSeen === undefined &&
    finding.coveredFraction === undefined
  ) {
    return null;
  }
  const bbox =
    finding.rect ??
    (finding.bbox
      ? {
          left: finding.bbox.x,
          top: finding.bbox.y,
          right: finding.bbox.x + finding.bbox.width,
          bottom: finding.bbox.y + finding.bbox.height,
          width: finding.bbox.width,
          height: finding.bbox.height,
        }
      : null);
  return {
    bbox,
    relatedSelector: finding.containerSelector ?? null,
    relatedBbox: null,
    coveredFraction: finding.coveredFraction ?? null,
    firstSeen: finding.firstSeen ?? finding.time ?? null,
    lastSeen: finding.lastSeen ?? finding.time ?? null,
    occurrences: finding.occurrences ?? 1,
  };
}

function minimumNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function maximumNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function normalizeSourceFile(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replaceAll("\\", "/");
  const qaWorkspace = normalized.lastIndexOf("/qa-workspace/");
  return qaWorkspace >= 0 ? normalized.slice(qaWorkspace + "/qa-workspace/".length) : normalized;
}

export function adjudicateLayoutCluster(
  cluster: LayoutClusterV1,
  inspection: LayoutInspectionV1,
  sequence: SequenceArtifactV1,
  policy: OverlapPolicyScan,
): LayoutClusterV1 {
  const policyRejected = policy.violations.some(
    (violation) =>
      cluster.sourceFiles.includes(violation.sourceFile) ||
      (violation.identity !== null && cluster.entityIds.includes(violation.identity)),
  );
  const intent = matchNarrowOverlapIntent(cluster, sequence);
  if (policyRejected) {
    return { ...cluster, status: "suppression_rejected", intentId: intent?.id ?? null };
  }
  if (!intent) return { ...cluster, status: "undeclared", intentId: null };
  const readable = intent.mustRemainReadable.every((entityId) =>
    inspection.entities.some(
      (entity) =>
        (entity.identity.entityId === entityId || entity.identity.hfId === entityId) &&
        entity.readabilityOwner === entityId &&
        entity.readable,
    ),
  );
  const zOrderCompatible = intent.zOrder.every((entityId, index) => {
    const nextId = intent.zOrder[index + 1];
    if (!nextId) return true;
    const current = inspection.entities.find(
      (entity) => entity.identity.entityId === entityId || entity.identity.hfId === entityId,
    );
    const next = inspection.entities.find(
      (entity) => entity.identity.entityId === nextId || entity.identity.hfId === nextId,
    );
    if (!current || !next || current.zIndex === "auto" || next.zIndex === "auto") return false;
    return current.zIndex <= next.zIndex;
  });
  return {
    ...cluster,
    status: readable && zOrderCompatible ? "declared_legible" : "declared_unreadable",
    intentId: intent.id,
  };
}

export function canAdjudicateLayoutFailure(
  commands: QaReceiptV1["commands"],
  findings: readonly QaFindingV1[],
  clusters: readonly LayoutClusterV1[],
  rawReport: unknown,
  policy: OverlapPolicyScan,
): boolean {
  if (commands[0]?.ok !== true || commands[1]?.ok !== false || policy.violations.length > 0) {
    return false;
  }
  const rawAccounting = normalizeQaFindingsWithAccounting("check", rawReport);
  if (
    rawAccounting.invalidRawErrorCount > 0 ||
    rawAccounting.rawErrorFindings.length === 0 ||
    rawAccounting.demotedRawErrorCount === 0
  ) {
    return false;
  }
  const receiptEvidence = new Set(findings.map(qaFindingAccountingKey));
  if (
    rawAccounting.rawErrorFindings.some(
      (finding) => !receiptEvidence.has(qaFindingAccountingKey(finding)),
    )
  ) {
    return false;
  }
  const blockers = findings.filter((finding) => finding.severity === "error");
  const layoutBlockers = blockers.filter((finding) =>
    ["content_overlap", "text_occluded"].includes(finding.code),
  );
  const nonLayoutBlockers = blockers.filter(
    (finding) => !["content_overlap", "text_occluded"].includes(finding.code),
  );
  if (blockers.length === 0) return onlyLayoutSectionFailed(rawReport);
  return (
    layoutBlockers.length > 0 &&
    nonLayoutBlockers.length === 0 &&
    clusters.length > 0 &&
    clusters.every((cluster) => cluster.status === "declared_legible") &&
    layoutBlockers.every((finding) => layoutFindingCoveredByClusters(finding, clusters)) &&
    onlyLayoutSectionFailed(rawReport)
  );
}

function layoutFindingCoveredByClusters(
  finding: QaFindingV1,
  clusters: readonly LayoutClusterV1[],
): boolean {
  if (finding.sourceFile === null) return false;
  const findingKey = layoutFindingKey(finding);
  const times =
    finding.times.length > 0
      ? finding.times
      : [finding.geometry?.firstSeen, finding.geometry?.lastSeen].filter(
          (time): time is number => time !== null && time !== undefined,
        );
  if (times.length === 0) return false;
  return times.every((time) =>
    clusters.some(
      (cluster) =>
        cluster.status === "declared_legible" &&
        cluster.findingKeys?.includes(findingKey) === true &&
        cluster.sourceFiles.includes(finding.sourceFile!) &&
        time >= cluster.timeRange[0] - 0.001 &&
        time <= cluster.timeRange[1] + 0.001,
    ),
  );
}

function qaFindingAccountingKey(finding: QaFindingV1): string {
  const { artifact: _artifact, ...evidence } = finding;
  return JSON.stringify(evidence);
}

function shouldDemoteLayoutFinding(
  finding: QaFindingV1,
  structuralInnerRoot: boolean,
  fullCanvasStructuralInnerRoot: boolean,
): boolean {
  // HyperFrames measures the generated inner composition viewport as a text
  // box. When that box exactly matches its declared canvas, intentional camera
  // crop on any descendant can be reported as persistent aggregate clipping.
  // The generated viewport cannot be resized without breaking the composition
  // contract, so keep the authored child findings and demote only this exact
  // renderer-owned self-box artifact.
  if (finding.code === "clipped_text" && fullCanvasStructuralInnerRoot) return true;

  const directlyTransient = ["content_overlap", "text_occluded"].includes(finding.code);
  const structuralTransient =
    structuralInnerRoot &&
    ["clipped_text", "text_box_overflow", "canvas_overflow"].includes(finding.code);
  if (
    (!directlyTransient && !structuralTransient) ||
    !finding.geometry ||
    finding.geometry.firstSeen === null ||
    finding.geometry.lastSeen === null ||
    finding.geometry.occurrences < 2
  ) {
    return false;
  }
  return finding.geometry.lastSeen - finding.geometry.firstSeen < 0.25;
}

function isFullCanvasStructuralInnerRoot(
  finding: z.infer<typeof QaFindingObservationSchema>,
): boolean {
  if (
    finding.code !== "clipped_text" ||
    finding.dataAttributes?.["data-hf-inner-root"] !== "true" ||
    finding.containerSelector !== undefined
  ) {
    return false;
  }
  const declaredWidth = Number(finding.dataAttributes["data-width"]);
  const declaredHeight = Number(finding.dataAttributes["data-height"]);
  const measuredWidth = finding.rect?.width ?? finding.bbox?.width;
  const measuredHeight = finding.rect?.height ?? finding.bbox?.height;
  if (
    !Number.isFinite(declaredWidth) ||
    !Number.isFinite(declaredHeight) ||
    declaredWidth <= 0 ||
    declaredHeight <= 0 ||
    measuredWidth === undefined ||
    measuredHeight === undefined
  ) {
    return false;
  }
  return (
    Math.abs(measuredWidth - declaredWidth) <= 0.5 &&
    Math.abs(measuredHeight - declaredHeight) <= 0.5
  );
}

function findingsForClusterInspection(
  findings: readonly QaFindingV1[],
  cluster: LayoutClusterV1,
): QaFindingV1[] {
  return findings.filter(
    (finding) =>
      isRepairableLayoutFinding(finding) &&
      finding.sourceFile !== null &&
      (cluster.findingKeys === undefined ||
        cluster.findingKeys.includes(layoutFindingKey(finding))) &&
      cluster.sourceFiles.includes(finding.sourceFile) &&
      findingTouchesClusterTime(finding, cluster),
  );
}

function findingTouchesClusterTime(finding: QaFindingV1, cluster: LayoutClusterV1): boolean {
  const first = finding.geometry?.firstSeen;
  const last = finding.geometry?.lastSeen;
  const points = [
    ...finding.times,
    ...(first === null || first === undefined ? [] : [first]),
    ...(last === null || last === undefined ? [] : [last]),
  ];
  if (points.length === 0) return false;
  const findingRange = [Math.min(...points), Math.max(...points)] as const;
  return (
    findingRange[0] <= cluster.timeRange[1] + 0.001 &&
    findingRange[1] >= cluster.timeRange[0] - 0.001
  );
}

function layoutInspectionFailure(
  cluster: LayoutClusterV1,
  findings: readonly QaFindingV1[],
  error: unknown,
  artifact: string,
): QaFindingV1 {
  const rawPairIsActionable = hasActionableRawLayoutPair(findings);
  return {
    command: "check",
    category: "layout_inspection",
    code: "layout_inspection_failed",
    severity: rawPairIsActionable ? "error" : "warning",
    sourceFile: cluster.sourceFiles[0] ?? null,
    selector: null,
    times: [cluster.sampleTime],
    message:
      `${rawPairIsActionable ? "Layout inspection failed" : "Layout detector indeterminate"} for ${cluster.id}: ${errorMessage(error)}`.slice(
        0,
        2_000,
      ),
    fixHint: rawPairIsActionable
      ? "The raw HyperFrames geometry identifies an actionable pair, so the cluster remains blocking. Use the original check evidence and rerun QA after correcting the candidate or detector evidence."
      : "The raw HyperFrames finding did not identify an actionable entity pair. Keep the original finding severity; do not treat this enrichment failure as an additional blocker.",
    artifact,
  };
}

function onlyLayoutSectionFailed(report: unknown): boolean {
  if (!isRecord(report) || !isRecord(report.layout) || report.layout.ok !== false) return false;
  for (const [name, section] of Object.entries(report)) {
    if (["ok", "strict", "layout", "snapshots", "_meta"].includes(name)) continue;
    if (isRecord(section) && section.ok === false) return false;
  }
  return true;
}

function contrastSample(finding: z.infer<typeof QaFindingObservationSchema>) {
  if (
    !finding.fg ||
    !finding.bg ||
    finding.ratio === undefined ||
    finding.requiredRatio === undefined
  ) {
    return null;
  }
  return {
    foreground: finding.fg,
    background: finding.bg,
    ratio: finding.ratio,
    requiredRatio: finding.requiredRatio,
    suggestedColor: finding.suggestedColor ?? null,
  };
}

function hasContrastSample(
  samples: Readonly<NonNullable<QaFindingV1["contrast"]>["samples"]>,
  sample: NonNullable<QaFindingV1["contrast"]>["samples"][number],
): boolean {
  return samples.some(
    (current) =>
      current.foreground === sample.foreground &&
      current.background === sample.background &&
      current.requiredRatio === sample.requiredRatio,
  );
}

function qaFindingObservations(
  report: unknown,
  fallbackCategory: string,
): Array<{ category: string; finding: unknown }> {
  if (!isRecord(report)) return [];
  const direct = Array.isArray(report.findings)
    ? report.findings.map((finding) => ({ category: fallbackCategory, finding }))
    : [];
  const nested = Object.entries(report).flatMap(([category, section]) => {
    if (!isRecord(section) || !Array.isArray(section.findings)) return [];
    return section.findings.map((finding) => ({ category, finding }));
  });
  return [...direct, ...nested];
}

function summarizeQaFindings(findings: readonly QaFindingV1[]) {
  return findings.reduce(
    (summary, finding) => {
      if (finding.severity === "error") summary.errorCount += 1;
      else if (finding.severity === "warning") summary.warningCount += 1;
      else summary.infoCount += 1;
      return summary;
    },
    { errorCount: 0, warningCount: 0, infoCount: 0 },
  );
}

function severityRank(severity: QaFindingV1["severity"]): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeFailure(result: ProcessResult, fallback: string): string {
  if (result.timedOut) return `${fallback}: command timed out`;
  return (result.stderr.trim() || fallback).slice(0, 4_000);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
