import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderReceiptV1Schema } from "../../src/shared";
import { createServerConfig } from "../../src/server/config";
import type { ServerConfig } from "../../src/server/config";
import type { HyperframesVerifier } from "../../src/server/hyperframes";
import { ProjectStore } from "../../src/server/project-store";
import { normalizeLegacyRenderReceipt, RenderManager } from "../../src/server/render-manager";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe("RenderManager custody", () => {
  it("derives legacy completed-render fps in memory without rewriting the stored receipt shape", () => {
    const legacy = {
      version: "sequences.render-receipt.v1",
      renderId: "render_00000000000000000000000000000000",
      projectId: "release-a",
      state: "completed",
      quality: "draft",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:01:00.000Z",
      finishedAt: "2026-07-15T00:01:00.000Z",
      acceptedCommit: "0".repeat(40),
      progress: { stage: "complete", percent: 100, message: "Verified" },
      cancelRequested: false,
      artifacts: {
        video: {
          path: "artifacts/video.mp4",
          downloadUrl: "/video",
          bytes: 1_024,
          codec: "h264",
          width: 1_920,
          height: 1_080,
          durationSeconds: 5,
        },
        sourceBundle: { path: "artifacts/source.zip", downloadUrl: "/source", bytes: 512 },
        firstFramePath: "artifacts/first.png",
        lastFramePath: "artifacts/last.png",
      },
      error: null,
    };

    expect(normalizeLegacyRenderReceipt(legacy, 30).artifacts?.video.fps).toBe(30);
    expect(legacy.artifacts.video).not.toHaveProperty("fps");
  });

  it("rejects frozen source that fails strict QA before invoking HyperFrames render", async () => {
    const harness = await createHarness(async () => ({ ok: false }));

    const started = await harness.manager.start("release-a", {
      version: "sequences.start-render.v1",
      quality: "draft",
    });
    const failed = await waitForRenderState(harness.manager, started.receipt.renderId, "failed");

    expect(failed.receipt.error?.message).toBe(
      "Pinned HyperFrames strict QA rejected the frozen render source",
    );
    expect(failed.receipt.error).toMatchObject({
      code: "hyperframes_render_failed",
      owner: "hyperframes",
    });
    expect(harness.verify).toHaveBeenCalledTimes(1);
    expect(harness.verify).toHaveBeenCalledWith(
      started.receipt.renderId,
      harness.projects.renderWorktreeRoot(started.receipt.renderId),
      harness.projects.renderRoot(started.receipt.renderId),
      expect.objectContaining({ sequence: expect.any(Object) }),
    );
    await expect(stat(harness.renderCommandMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await waitForMissing(harness.projects.renderWorktreeRoot(started.receipt.renderId));
  });

  it("admits exactly one of two concurrent starts for the project", async () => {
    let releaseVerifier = (): void => {};
    const verifierGate = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    const harness = await createHarness(async () => {
      await verifierGate;
      return { ok: false };
    });
    const request = {
      version: "sequences.start-render.v1" as const,
      quality: "draft" as const,
    };

    const results = await Promise.allSettled([
      harness.manager.start("release-a", request),
      harness.manager.start("release-a", request),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<RenderManager["start"]>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 409, code: "render_active" });
    expect(await harness.manager.listReceipts()).toHaveLength(1);

    releaseVerifier();
    await waitForRenderState(harness.manager, fulfilled[0]!.value.receipt.renderId, "failed");
  });

  it("resumes the exact authorized commit after a server restart", async () => {
    let releaseVerifier = (): void => {};
    const verifierGate = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    const harness = await createHarness(async () => {
      await verifierGate;
      return { ok: false };
    });
    const renderId = "render_11111111111111111111111111111111";
    const acceptedCommit = await harness.projects.acceptedCommit();
    await writeInterruptedReceipt(harness, renderId, acceptedCommit);
    await harness.projects.createRenderSnapshot(renderId, acceptedCommit);

    const resumed = new RenderManager(harness.config, harness.projects, harness.verifier);
    await resumed.initialize();

    await expect(
      resumed.start("release-a", {
        version: "sequences.start-render.v1",
        quality: "draft",
      }),
    ).rejects.toMatchObject({ status: 409, code: "render_active" });
    await waitForCondition(() => harness.verify.mock.calls.length === 1);
    expect((await resumed.get(renderId)).receipt).toMatchObject({
      renderId,
      acceptedCommit,
      quality: "draft",
      state: "preparing",
    });

    releaseVerifier();
    const failed = await waitForRenderState(resumed, renderId, "failed");
    expect(failed.receipt.acceptedCommit).toBe(acceptedCommit);
    expect(failed.receipt.error).toMatchObject({
      code: "hyperframes_render_failed",
      owner: "hyperframes",
    });
    expect(failed.receipt.error?.code).not.toBe("server_restarted");
    await waitForMissing(harness.projects.renderWorktreeRoot(renderId));
  });

  it("does not abort render work when an observational progress write fails", async () => {
    const harness = await createHarness(async () => ({ ok: false }));
    const renderId = "render_22222222222222222222222222222222";
    await writeInterruptedReceipt(harness, renderId, await harness.projects.acceptedCommit());
    await harness.manager.get(renderId);
    const internals = harness.manager as unknown as {
      captureProgress(id: string, line: string): Promise<void>;
      update: ReturnType<typeof vi.fn>;
    };
    internals.update = vi.fn(async () => {
      throw new Error("simulated progress receipt contention");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(internals.captureProgress(renderId, "render 50%")).resolves.toBeUndefined();
      expect(internals.update).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[sequences] render progress update skipped",
        "simulated progress receipt contention",
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

async function createHarness(verifyResult: () => Promise<{ ok: boolean }>): Promise<{
  manager: RenderManager;
  projects: ProjectStore;
  verify: ReturnType<typeof vi.fn>;
  verifier: HyperframesVerifier;
  config: ServerConfig;
  renderCommandMarker: string;
}> {
  const sourceRoot = process.cwd();
  const tempRoot = await mkdtemp(join(tmpdir(), "sequences-render-manager-"));
  roots.push(tempRoot);
  const seedRoot = join(tempRoot, "fixture");
  await cp(join(sourceRoot, "fixtures", "release-a"), seedRoot, { recursive: true });

  const renderCommandMarker = join(tempRoot, "render-command-called.txt");
  const fakeCli = join(tempRoot, "node_modules", "hyperframes", "dist", "cli.js");
  await mkdir(join(fakeCli, ".."), { recursive: true });
  await writeFile(
    fakeCli,
    `require("node:fs").appendFileSync(${JSON.stringify(renderCommandMarker)}, "called\\n");\n`,
    "utf8",
  );

  const config = createServerConfig({
    workspaceRoot: tempRoot,
    acceptedRoot: join(tempRoot, "accepted"),
    seedRoot,
    candidatesRoot: join(tempRoot, "candidates"),
    runsRoot: join(tempRoot, "runs"),
    rendersRoot: join(tempRoot, "renders"),
    renderWorktreesRoot: join(tempRoot, "render-worktrees"),
    hyperframesCommand: process.execPath,
  });
  const projects = new ProjectStore(config);
  await projects.initialize();
  const verify = vi.fn(verifyResult);
  const verifier = {
    verify,
    cancel: vi.fn(() => false),
  } as unknown as HyperframesVerifier;
  const manager = new RenderManager(config, projects, verifier);
  await manager.initialize();
  return { manager, projects, verify, verifier, config, renderCommandMarker };
}

async function writeInterruptedReceipt(
  harness: Pick<Awaited<ReturnType<typeof createHarness>>, "projects">,
  renderId: string,
  acceptedCommit: string,
): Promise<void> {
  const root = harness.projects.renderRoot(renderId);
  await mkdir(root, { recursive: false });
  const now = new Date().toISOString();
  const receipt = RenderReceiptV1Schema.parse({
    version: "sequences.render-receipt.v1",
    renderId,
    projectId: "release-a",
    state: "rendering",
    quality: "draft",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    acceptedCommit,
    progress: { stage: "render", percent: 40, message: "HyperFrames render 37%" },
    cancelRequested: false,
    artifacts: null,
    error: null,
  });
  await writeFile(join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

async function waitForRenderState(manager: RenderManager, renderId: string, expected: "failed") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await manager.get(renderId);
    if (response.receipt.state === expected) return response;
    if (["completed", "cancelled"].includes(response.receipt.state)) {
      throw new Error(
        response.receipt.error?.message ?? `Render ended in ${response.receipt.state}`,
      );
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for render state ${expected}`);
}

async function waitForMissing(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for cleanup of ${path}`);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("Timed out waiting for condition");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
