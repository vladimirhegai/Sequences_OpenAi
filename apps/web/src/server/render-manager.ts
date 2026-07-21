import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  PROJECT_ID,
  RenderReceiptV1Schema,
  RenderResponseV1Schema,
  type RenderReceiptV1,
  type RenderResponseV1,
  type StartRenderRequestV1,
} from "../shared";
import { AudioDirector } from "./audio-director";
import type { ServerConfig } from "./config";
import { ApiProblem, errorMessage } from "./errors";
import { atomicWriteJson, posixPath, readJson } from "./files";
import { HyperframesVerifier } from "./hyperframes";
import {
  isolatedToolEnvironment,
  runProcess,
  startProcess,
  type ProcessResult,
  type RunningProcess,
} from "./process-runner";
import { ProjectStore } from "./project-store";
import {
  assertLaunchSequenceSemantics,
  assertLaunchMotionSidecar,
  readSequenceArtifact,
} from "./sequence-artifact";

const ProbeSchema = z
  .object({
    streams: z.array(
      z
        .object({
          codec_type: z.string().optional(),
          codec_name: z.string().optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          avg_frame_rate: z.string().optional(),
        })
        .passthrough(),
    ),
    format: z
      .object({
        duration: z.string(),
        size: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const MUTABLE_RENDER_STATES = new Set(["queued", "preparing", "rendering", "verifying"]);

export class RenderManager {
  private readonly cache = new Map<string, RenderReceiptV1>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, RunningProcess>();
  private readonly audio: AudioDirector;
  private activeProjectRender: string | null = null;
  private startingProjectRender = false;

  constructor(
    private readonly config: ServerConfig,
    private readonly projects: ProjectStore,
    private readonly hyperframes: HyperframesVerifier,
  ) {
    this.audio = new AudioDirector(config.workspaceRoot);
  }

  async initialize(): Promise<void> {
    await mkdir(this.config.rendersRoot, { recursive: true });
    let resumedInterruptedRender = false;
    for (const receipt of await this.listReceipts()) {
      if (!MUTABLE_RENDER_STATES.has(receipt.state)) continue;
      await this.projects.removeRenderSnapshot(receipt.renderId);
      if (receipt.cancelRequested) {
        await this.markCancelled(receipt.renderId);
        continue;
      }
      if (resumedInterruptedRender) {
        await this.transition(receipt.renderId, "failed", {
          progress: {
            stage: "error",
            percent: receipt.progress.percent,
            message: "A newer interrupted render was resumed",
          },
          error: {
            code: "interrupted_render_superseded",
            message: "A newer interrupted render owns restart recovery for this project",
            owner: "server",
          },
        });
        continue;
      }
      const resumed = await this.transition(receipt.renderId, "queued", {
        cancelRequested: false,
        artifacts: null,
        error: null,
        progress: {
          stage: "queued",
          percent: 0,
          message: "Resuming the authorized render after server restart",
        },
      });
      this.launch(resumed);
      resumedInterruptedRender = true;
    }
  }

  async start(projectId: string, request: StartRenderRequestV1): Promise<RenderResponseV1> {
    if (projectId !== PROJECT_ID)
      throw new ApiProblem(404, "project_not_found", "Project not found");
    if (this.activeProjectRender || this.startingProjectRender) {
      throw new ApiProblem(
        409,
        "render_active",
        this.activeProjectRender
          ? `Render ${this.activeProjectRender} is already running`
          : "A render is already preparing",
      );
    }
    this.startingProjectRender = true;
    try {
      return await this.startReserved(projectId, request);
    } finally {
      this.startingProjectRender = false;
    }
  }

  private async startReserved(
    projectId: string,
    request: StartRenderRequestV1,
  ): Promise<RenderResponseV1> {
    if (projectId !== PROJECT_ID)
      throw new ApiProblem(404, "project_not_found", "Project not found");
    if (this.activeProjectRender) {
      throw new ApiProblem(
        409,
        "render_active",
        `Render ${this.activeProjectRender} is already running`,
      );
    }
    const acceptedCommit = await this.projects.checkpointAcceptedChanges(
      "Checkpoint local accepted-source edits before render",
    );
    const renderId = `render_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    const receipt = RenderReceiptV1Schema.parse({
      version: "sequences.render-receipt.v1",
      renderId,
      projectId: PROJECT_ID,
      state: "queued",
      quality: request.quality,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      acceptedCommit,
      progress: { stage: "queued", percent: 0, message: "Render queued from accepted source" },
      cancelRequested: false,
      artifacts: null,
      error: null,
    });
    const root = this.projects.renderRoot(renderId);
    await mkdir(root, { recursive: false });
    await this.save(receipt);
    this.launch(receipt);
    return this.response(receipt);
  }

  private launch(receipt: RenderReceiptV1): void {
    const { renderId } = receipt;
    if (this.activeProjectRender) {
      throw new Error(`Render ${this.activeProjectRender} is already running`);
    }
    this.activeProjectRender = renderId;
    void this.execute(receipt)
      .catch((error: unknown) => {
        console.error("[sequences] unrecoverable render persistence failure", errorMessage(error));
      })
      .finally(() => {
        if (this.activeProjectRender === renderId) this.activeProjectRender = null;
      });
  }

  async get(renderId: string): Promise<RenderResponseV1> {
    return this.response(await this.receiptOr404(renderId));
  }

  async cancel(renderId: string): Promise<RenderResponseV1> {
    const receipt = await this.receiptOr404(renderId);
    if (!MUTABLE_RENDER_STATES.has(receipt.state)) {
      throw new ApiProblem(
        409,
        "render_not_cancellable",
        `A ${receipt.state} render cannot be cancelled`,
      );
    }
    const updated = await this.update(renderId, (current) => ({
      ...current,
      cancelRequested: true,
      updatedAt: new Date().toISOString(),
      progress: { ...current.progress, message: "Cancelling render" },
    }));
    this.active.get(renderId)?.cancel();
    this.hyperframes.cancel(renderId);
    return this.response(updated);
  }

  async listReceipts(): Promise<RenderReceiptV1[]> {
    let entries: Array<{ isDirectory(): boolean; name: string }>;
    try {
      entries = await readdir(this.config.rendersRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const receipts: RenderReceiptV1[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^render_[0-9a-f]{32}$/.test(entry.name)) continue;
      try {
        receipts.push(await this.load(entry.name));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return receipts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async artifact(
    renderId: string,
    kind: "video" | "source",
  ): Promise<{ path: string; filename: string; contentType: string }> {
    const receipt = await this.receiptOr404(renderId);
    if (receipt.state !== "completed" || !receipt.artifacts) {
      throw new ApiProblem(
        409,
        "render_not_complete",
        "Render downloads are available only after verification completes",
      );
    }
    const path = join(
      this.projects.renderRoot(renderId),
      kind === "video" ? "video.mp4" : "source.zip",
    );
    await stat(path);
    return kind === "video"
      ? {
          path,
          filename: `sequences-${receipt.acceptedCommit.slice(0, 12)}.mp4`,
          contentType: "video/mp4",
        }
      : {
          path,
          filename: `sequences-source-${receipt.acceptedCommit.slice(0, 12)}.zip`,
          contentType: "application/zip",
        };
  }

  private async execute(initial: RenderReceiptV1): Promise<void> {
    const { renderId, acceptedCommit } = initial;
    const renderRoot = this.projects.renderRoot(renderId);
    const videoPath = join(renderRoot, "video.mp4");
    const bundlePath = join(renderRoot, "source.zip");
    let snapshotCreated = false;
    try {
      await mkdir(join(renderRoot, "tmp"), { recursive: true });
      await this.transition(renderId, "preparing", {
        progress: { stage: "snapshot", percent: 5, message: "Freezing the accepted Git commit" },
      });
      await this.stopIfCancelled(renderId);
      const snapshotRoot = await this.projects.createRenderSnapshot(renderId, acceptedCommit);
      snapshotCreated = true;
      const sequence = await readSequenceArtifact(snapshotRoot);
      assertLaunchSequenceSemantics(sequence!);
      await this.audio.assertAudioDirection(sequence!);
      await assertLaunchMotionSidecar(snapshotRoot, sequence!);
      await this.update(renderId, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        progress: {
          stage: "snapshot",
          percent: 8,
          message: "Strict-checking the frozen source before render",
        },
      }));
      const qa = await this.hyperframes.verify(renderId, snapshotRoot, renderRoot, {
        sequence: sequence!,
      });
      if (!qa.ok) throw new Error("Pinned HyperFrames strict QA rejected the frozen render source");
      await this.projects.archiveCommit(acceptedCommit, bundlePath);
      await this.stopIfCancelled(renderId);

      await this.transition(renderId, "rendering", {
        progress: {
          stage: "render",
          percent: 10,
          message: "HyperFrames is rendering the approved source",
        },
      });
      const cliEntry = join(
        this.config.workspaceRoot,
        "node_modules",
        "hyperframes",
        "dist",
        "cli.js",
      );
      const result = await this.command(
        renderId,
        this.config.hyperframesCommand,
        [
          cliEntry,
          "render",
          snapshotRoot,
          "--quality",
          initial.quality,
          "--workers",
          "1",
          "--output",
          videoPath,
        ],
        snapshotRoot,
        30 * 60 * 1_000,
        (line) => this.captureProgress(renderId, line),
      );
      await writeFile(join(renderRoot, "render.stdout.log"), result.stdout, "utf8");
      await writeFile(
        join(renderRoot, "render.stderr.log"),
        result.stderr.slice(0, 256 * 1_024),
        "utf8",
      );
      if (result.cancelled || (await this.load(renderId)).cancelRequested) {
        await this.markCancelled(renderId);
        return;
      }
      if (result.timedOut) throw new Error("HyperFrames render exceeded its 30 minute timeout");
      if (result.exitCode !== 0) {
        throw new Error(
          `HyperFrames render failed: ${result.stderr.trim() || `process exited with ${String(result.exitCode)}`}`,
        );
      }

      // Director-declared sound plan: the host verifies the vendored catalog
      // hashes and muxes the bed and cues into the silent producer MP4. The
      // replace is atomic — a failed mix preserves the silent render for the
      // failure evidence and the run fails loud.
      const mixPlan = await this.audio.mixPlan({
        videoPath,
        outputPath: join(renderRoot, "tmp", "video-with-audio.mp4"),
        sequence: sequence!,
      });
      let audioArtifact: { soundtrackId: string; cueCount: number; codec: string } | null = null;
      if (mixPlan) {
        await this.update(renderId, (current) => ({
          ...current,
          updatedAt: new Date().toISOString(),
          progress: {
            stage: "render",
            percent: 90,
            message: `Mixing the directed soundtrack (${mixPlan.soundtrackId}, ${mixPlan.cueCount} cue${mixPlan.cueCount === 1 ? "" : "s"})`,
          },
        }));
        const mix = await this.command(
          renderId,
          this.config.ffmpegCommand,
          mixPlan.args,
          renderRoot,
          5 * 60_000,
        );
        if (mix.cancelled) throw new RenderCancelled();
        if (mix.exitCode !== 0) {
          throw new Error(`Directed audio mix failed: ${mix.stderr.trim().slice(-2_000)}`);
        }
        const silentBackup = join(renderRoot, "tmp", "video-silent.mp4");
        await rename(videoPath, silentBackup);
        try {
          await rename(join(renderRoot, "tmp", "video-with-audio.mp4"), videoPath);
          await rm(silentBackup, { force: true });
        } catch (error) {
          await rename(silentBackup, videoPath);
          throw error;
        }
        audioArtifact = {
          soundtrackId: mixPlan.soundtrackId,
          cueCount: mixPlan.cueCount,
          codec: "aac",
        };
      }

      await this.transition(renderId, "verifying", {
        progress: {
          stage: "verify",
          percent: 92,
          message: "Verifying MP4 metadata and boundary frames",
        },
      });
      const artifacts = await this.verifyArtifacts(
        initial,
        sequence!,
        videoPath,
        bundlePath,
        audioArtifact,
      );
      await this.stopIfCancelled(renderId);
      await this.transition(renderId, "completed", {
        artifacts,
        progress: {
          stage: "complete",
          percent: 100,
          message: "Verified MP4 and source bundle are ready",
        },
      });
    } catch (error) {
      const current = await this.load(renderId);
      if (current.cancelRequested || error instanceof RenderCancelled) {
        if (MUTABLE_RENDER_STATES.has(current.state)) await this.markCancelled(renderId);
        return;
      }
      if (!MUTABLE_RENDER_STATES.has(current.state)) return;
      await this.transition(renderId, "failed", {
        progress: {
          stage: "error",
          percent: current.progress.percent,
          message: "Render failed with preserved evidence",
        },
        error: classifyRenderFailure(error),
      });
    } finally {
      this.active.delete(renderId);
      if (snapshotCreated) {
        try {
          await this.projects.removeRenderSnapshot(renderId);
        } catch (error) {
          console.error("[sequences] render snapshot cleanup failed", errorMessage(error));
        }
      }
    }
  }

  private async verifyArtifacts(
    receipt: RenderReceiptV1,
    sequence: NonNullable<Awaited<ReturnType<typeof readSequenceArtifact>>>,
    videoPath: string,
    bundlePath: string,
    audioArtifact: { soundtrackId: string; cueCount: number; codec: string } | null,
  ): Promise<NonNullable<RenderReceiptV1["artifacts"]>> {
    const video = await stat(videoPath);
    if (!video.isFile() || video.size < 1_024)
      throw new Error("Rendered MP4 is missing or implausibly small");
    const bundle = await stat(bundlePath);
    if (!bundle.isFile() || bundle.size < 1)
      throw new Error("Accepted source bundle is missing or empty");

    const root = this.projects.renderRoot(receipt.renderId);
    const probe = await this.command(
      receipt.renderId,
      this.config.ffprobeCommand,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration,size",
        "-of",
        "json",
        videoPath,
      ],
      root,
      30_000,
    );
    await writeFile(join(root, "ffprobe.json"), probe.stdout, "utf8");
    if (probe.cancelled) throw new RenderCancelled();
    if (probe.exitCode !== 0)
      throw new Error(probe.stderr.trim() || "ffprobe could not read the rendered MP4");
    const metadata = ProbeSchema.parse(JSON.parse(probe.stdout) as unknown);
    const videoStream = metadata.streams.find((stream) => stream.codec_type === "video");
    const durationSeconds = Number(metadata.format.duration);
    if (!videoStream?.codec_name || !videoStream.width || !videoStream.height) {
      throw new Error("ffprobe did not report a playable video stream");
    }
    const audioStream = metadata.streams.find((stream) => stream.codec_type === "audio");
    if (audioArtifact && audioStream?.codec_name !== audioArtifact.codec) {
      throw new Error(
        `Directed sound plan was mixed but ffprobe did not report the ${audioArtifact.codec} audio stream`,
      );
    }
    if (!audioArtifact && audioStream) {
      throw new Error("Rendered MP4 carries an audio stream without a directed sound plan");
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("ffprobe reported an invalid video duration");
    }
    const fps = parseFrameRate(videoStream.avg_frame_rate);
    if (!fps) throw new Error("ffprobe did not report a valid video frame rate");
    if (
      videoStream.width !== sequence.format!.width ||
      videoStream.height !== sequence.format!.height
    ) {
      throw new Error("Rendered MP4 dimensions do not match sequence.json");
    }
    if (Math.abs(fps - sequence.format!.fps) > 0.05) {
      throw new Error("Rendered MP4 frame rate does not match sequence.json");
    }
    const durationTolerance = Math.max(0.1, 2 / sequence.format!.fps);
    if (Math.abs(durationSeconds - sequence.format!.targetDuration) > durationTolerance) {
      throw new Error("Rendered MP4 duration does not match sequence.json");
    }
    if (metadata.format.size && Number(metadata.format.size) !== video.size) {
      throw new Error("ffprobe file size did not match the rendered MP4");
    }

    const firstFrame = join(root, "first-frame.png");
    const lastFrame = join(root, "last-frame.png");
    await this.decodeFrame(receipt.renderId, videoPath, firstFrame, ["-ss", "0"]);
    const tailOffset = Math.max(0.05, Math.min(0.25, durationSeconds / 2));
    await this.decodeFrame(receipt.renderId, videoPath, lastFrame, [
      "-sseof",
      `-${tailOffset.toFixed(3)}`,
    ]);
    for (const frame of [firstFrame, lastFrame]) {
      const frameFile = await stat(frame);
      if (!frameFile.isFile() || frameFile.size < 100)
        throw new Error("FFmpeg did not decode a playable boundary frame");
    }

    const artifactPath = (path: string) => posixPath(relative(this.config.workspaceRoot, path));
    return {
      video: {
        path: artifactPath(videoPath),
        downloadUrl: `/api/v1/renders/${receipt.renderId}/video`,
        bytes: video.size,
        codec: videoStream.codec_name,
        width: videoStream.width,
        height: videoStream.height,
        fps,
        durationSeconds,
      },
      sourceBundle: {
        path: artifactPath(bundlePath),
        downloadUrl: `/api/v1/renders/${receipt.renderId}/source`,
        bytes: bundle.size,
      },
      firstFramePath: artifactPath(firstFrame),
      lastFramePath: artifactPath(lastFrame),
      audio: audioArtifact,
    };
  }

  private async decodeFrame(
    renderId: string,
    videoPath: string,
    outputPath: string,
    seek: string[],
  ): Promise<void> {
    const result = await this.command(
      renderId,
      this.config.ffmpegCommand,
      ["-v", "error", ...seek, "-i", videoPath, "-frames:v", "1", "-y", outputPath],
      this.projects.renderRoot(renderId),
      60_000,
    );
    if (result.cancelled) throw new RenderCancelled();
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || "FFmpeg could not decode a boundary frame");
  }

  private async command(
    renderId: string,
    executable: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    onStdoutLine?: (line: string) => void | Promise<void>,
  ): Promise<ProcessResult> {
    const handle = startProcess({
      executable,
      args,
      cwd,
      env: isolatedToolEnvironment(renderId, join(this.projects.renderRoot(renderId), "tmp")),
      timeoutMs,
      maxStdoutBytes: 16 * 1_024 * 1_024,
      maxStderrBytes: 256 * 1_024,
      ...(onStdoutLine ? { onStdoutLine } : {}),
    });
    this.active.set(renderId, handle);
    try {
      return await handle.result;
    } finally {
      if (this.active.get(renderId) === handle) this.active.delete(renderId);
    }
  }

  private async captureProgress(renderId: string, line: string): Promise<void> {
    try {
      const match = /(?:^|\s)(\d{1,3})(?:\.\d+)?%/.exec(line);
      if (!match) return;
      const renderPercent = Math.min(100, Number(match[1]));
      const percent = 10 + Math.floor(renderPercent * 0.8);
      const current = await this.load(renderId);
      if (current.state !== "rendering" || percent <= current.progress.percent) return;
      await this.update(renderId, (value) => ({
        ...value,
        updatedAt: new Date().toISOString(),
        progress: { stage: "render", percent, message: `HyperFrames render ${renderPercent}%` },
      }));
    } catch (error) {
      // Percentage updates are observational only. Let the renderer reach its
      // authoritative exit/artifact checks even if one progress write fails.
      console.error("[sequences] render progress update skipped", errorMessage(error));
    }
  }

  private async stopIfCancelled(renderId: string): Promise<void> {
    if ((await this.load(renderId)).cancelRequested) throw new RenderCancelled();
  }

  private async markCancelled(renderId: string): Promise<RenderReceiptV1> {
    return this.transition(renderId, "cancelled", {
      cancelRequested: true,
      progress: {
        stage: "complete",
        percent: (await this.load(renderId)).progress.percent,
        message: "Render cancelled",
      },
      error: null,
    });
  }

  private async transition(
    renderId: string,
    state: RenderReceiptV1["state"],
    patch: Partial<RenderReceiptV1>,
  ): Promise<RenderReceiptV1> {
    return this.update(renderId, (current) => {
      const now = new Date().toISOString();
      return {
        ...current,
        ...patch,
        version: current.version,
        renderId: current.renderId,
        projectId: current.projectId,
        acceptedCommit: current.acceptedCommit,
        state,
        updatedAt: now,
        finishedAt: ["completed", "failed", "cancelled"].includes(state) ? now : null,
      };
    });
  }

  private async receiptOr404(renderId: string): Promise<RenderReceiptV1> {
    try {
      return await this.load(renderId);
    } catch (error) {
      if (!isMissing(error) && !(error instanceof z.ZodError)) throw error;
      throw new ApiProblem(404, "render_not_found", "Render not found");
    }
  }

  private async load(renderId: string): Promise<RenderReceiptV1> {
    const cached = this.cache.get(renderId);
    if (cached) return cached;
    const stored = await readJson(
      join(this.projects.renderRoot(renderId), "receipt.json"),
      z.unknown(),
    );
    const current = RenderReceiptV1Schema.safeParse(stored);
    const receipt = current.success
      ? current.data
      : isLegacyRenderWithoutFps(stored)
        ? normalizeLegacyRenderReceipt(stored, await this.legacyFrameRate(renderId))
        : RenderReceiptV1Schema.parse(stored);
    this.cache.set(renderId, receipt);
    return receipt;
  }

  private async legacyFrameRate(renderId: string): Promise<number> {
    const root = this.projects.renderRoot(renderId);
    const probe = await runProcess({
      executable: this.config.ffprobeCommand,
      args: [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        join(root, "video.mp4"),
      ],
      cwd: root,
      env: isolatedToolEnvironment(renderId, this.config.runsRoot),
      timeoutMs: 30_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 16_384,
    });
    const fps = parseFrameRate(probe.stdout.trim().split(/\r?\n/, 1)[0]);
    if (probe.exitCode !== 0 || !fps) {
      throw new Error(
        probe.stderr.trim() || `Legacy render ${renderId} has no verifiable frame rate`,
      );
    }
    return fps;
  }

  private async save(receipt: RenderReceiptV1): Promise<RenderReceiptV1> {
    const persisted = await atomicWriteJson(
      join(this.projects.renderRoot(receipt.renderId), "receipt.json"),
      RenderReceiptV1Schema,
      receipt,
    );
    this.cache.set(receipt.renderId, persisted);
    return persisted;
  }

  private async update(
    renderId: string,
    operation: (receipt: RenderReceiptV1) => RenderReceiptV1,
  ): Promise<RenderReceiptV1> {
    const previous = this.tails.get(renderId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () =>
        this.save(RenderReceiptV1Schema.parse(operation(await this.load(renderId)))),
      );
    this.tails.set(
      renderId,
      next.catch(() => undefined),
    );
    return next;
  }

  private response(receipt: RenderReceiptV1): RenderResponseV1 {
    return RenderResponseV1Schema.parse({ version: "sequences.render-response.v1", receipt });
  }
}

class RenderCancelled extends Error {}

export function normalizeLegacyRenderReceipt(value: unknown, fps: number): RenderReceiptV1 {
  if (!isLegacyRenderWithoutFps(value)) return RenderReceiptV1Schema.parse(value);
  return RenderReceiptV1Schema.parse({
    ...value,
    artifacts: {
      ...value.artifacts,
      video: { ...value.artifacts.video, fps },
    },
  });
}

function isLegacyRenderWithoutFps(value: unknown): value is {
  version: "sequences.render-receipt.v1";
  state: "completed";
  artifacts: { video: Record<string, unknown> & { fps?: never } } & Record<string, unknown>;
} & Record<string, unknown> {
  if (!isRecord(value) || value.version !== "sequences.render-receipt.v1") return false;
  if (value.state !== "completed" || !isRecord(value.artifacts)) return false;
  return isRecord(value.artifacts.video) && value.artifacts.video.fps === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numeratorText, denominatorText = "1"] = value.split("/", 2);
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function classifyRenderFailure(error: unknown): NonNullable<RenderReceiptV1["error"]> {
  const message = errorMessage(error).slice(0, 4_000);
  if (/Git|snapshot|archive/i.test(message))
    return { code: "render_source_failed", message, owner: "git" };
  if (/HyperFrames|strict QA|render exited|render exceeded/i.test(message))
    return { code: "hyperframes_render_failed", message, owner: "hyperframes" };
  if (/ffprobe|FFmpeg|frame|video stream|duration|MP4/i.test(message)) {
    return { code: "render_verification_failed", message, owner: "ffmpeg" };
  }
  return { code: "render_failed", message, owner: "server" };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
