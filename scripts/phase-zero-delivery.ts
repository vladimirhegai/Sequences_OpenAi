import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSequencesRuntime } from "../apps/web/src/server/app";
import { RenderResponseV1Schema, SessionResponseV1Schema } from "../apps/web/src/shared";

const root = resolve(import.meta.dir, "..");
const evidenceRoot = resolve(
  process.env.SEQUENCES_PHASE_EVIDENCE_DIR ?? join(root, "artifacts", "tests", "phase-0", "latest"),
);
const deliveryRoot = join(evidenceRoot, "delivery");
const tempRoot = await mkdtemp(join(tmpdir(), "sequences-phase-zero-delivery-"));
const origin = "http://127.0.0.1:4317";
const host = "127.0.0.1:4317";

await mkdir(deliveryRoot, { recursive: true });
try {
  const runtime = await createSequencesRuntime({
    workspaceRoot: root,
    acceptedRoot: join(tempRoot, "accepted"),
    seedRoot: join(root, "fixtures", "release-a"),
    candidatesRoot: join(tempRoot, "candidates"),
    runsRoot: join(tempRoot, "runs"),
    rendersRoot: deliveryRoot,
    renderWorktreesRoot: join(tempRoot, "render-worktrees"),
    skillsRoot: join(root, ".agents", "skills"),
    skillsManifestPath: join(root, ".agents", "skills-manifest.json"),
    registryManifestPath: join(root, ".agents", "registry", "registry.json"),
    expectedOrigin: origin,
    expectedHost: host,
    bootToken: "b".repeat(43),
    sessionToken: "s".repeat(43),
    csrfToken: "c".repeat(43),
    staticAccessToken: "f".repeat(43),
  });

  const sessionResponse = await runtime.app.request("/api/v1/session", {
    method: "POST",
    headers: { Host: host, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ version: "sequences.create-session.v1", bootToken: "b".repeat(43) }),
  });
  if (sessionResponse.status !== 200)
    throw new Error(`Session route returned HTTP ${sessionResponse.status}`);
  const session = SessionResponseV1Schema.parse(await sessionResponse.json());
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Session route did not set its local cookie");
  const mutationHeaders = {
    Host: host,
    Origin: origin,
    Cookie: cookie,
    "Content-Type": "application/json",
    "X-Sequences-CSRF": session.csrfToken,
  };
  const readHeaders = { Host: host, Cookie: cookie };

  const start = await runtime.app.request("/api/v1/projects/release-a/renders", {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ version: "sequences.start-render.v1", quality: "draft" }),
  });
  if (start.status !== 202)
    throw new Error(`Render start returned HTTP ${start.status}: ${await start.text()}`);
  let response = RenderResponseV1Schema.parse(await start.json());
  let lastProgress = -1;
  const deadline = Date.now() + 25 * 60_000;
  while (["queued", "preparing", "rendering", "verifying"].includes(response.receipt.state)) {
    if (response.receipt.progress.percent !== lastProgress) {
      lastProgress = response.receipt.progress.percent;
      console.log(`${response.receipt.progress.percent}% ${response.receipt.progress.message}`);
    }
    if (Date.now() >= deadline) {
      await runtime.app.request(`/api/v1/renders/${response.receipt.renderId}/cancel`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ version: "sequences.render-action.v1" }),
      });
      throw new Error("Phase 0 draft render exceeded its 25 minute acceptance timeout");
    }
    await Bun.sleep(500);
    const poll = await runtime.app.request(`/api/v1/renders/${response.receipt.renderId}`, {
      headers: readHeaders,
    });
    if (poll.status !== 200) throw new Error(`Render status returned HTTP ${poll.status}`);
    response = RenderResponseV1Schema.parse(await poll.json());
  }
  if (response.receipt.state !== "completed" || !response.receipt.artifacts) {
    throw new Error(response.receipt.error?.message ?? `Render ended in ${response.receipt.state}`);
  }

  const video = await download(
    runtime.app,
    response.receipt.artifacts.video.downloadUrl,
    readHeaders,
    "video/mp4",
  );
  const source = await download(
    runtime.app,
    response.receipt.artifacts.sourceBundle.downloadUrl,
    readHeaders,
    "application/zip",
  );
  if (video.bytes.byteLength !== response.receipt.artifacts.video.bytes) {
    throw new Error("Downloaded MP4 size did not match its verified render receipt");
  }
  if (source.bytes.byteLength !== response.receipt.artifacts.sourceBundle.bytes) {
    throw new Error("Downloaded source bundle size did not match its verified render receipt");
  }
  await Promise.all([
    writeFile(join(evidenceRoot, "result.mp4"), video.bytes),
    writeFile(join(evidenceRoot, "source.zip"), source.bytes),
  ]);
  const receipt = {
    version: "sequences.phase-zero-delivery.v1",
    render: response.receipt,
    downloads: {
      video: {
        status: video.status,
        contentType: video.contentType,
        bytes: video.bytes.byteLength,
      },
      source: {
        status: source.status,
        contentType: source.contentType,
        bytes: source.bytes.byteLength,
      },
    },
    resultPaths: [
      "artifacts/tests/phase-0/latest/result.mp4",
      "artifacts/tests/phase-0/latest/source.zip",
    ],
  };
  await writeFile(
    join(evidenceRoot, "delivery-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `Verified ${response.receipt.artifacts.video.codec} ${response.receipt.artifacts.video.width}x${response.receipt.artifacts.video.height} ` +
      `${response.receipt.artifacts.video.durationSeconds.toFixed(2)}s and both download routes.`,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function download(
  app: Awaited<ReturnType<typeof createSequencesRuntime>>["app"],
  path: string,
  headers: HeadersInit,
  expectedContentType: string,
) {
  const response = await app.request(path, { headers });
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || !contentType.startsWith(expectedContentType)) {
    throw new Error(
      `Download ${path} returned HTTP ${response.status} (${contentType || "no content type"})`,
    );
  }
  if (!response.headers.get("content-disposition")?.startsWith("attachment;")) {
    throw new Error(`Download ${path} did not provide an attachment filename`);
  }
  return {
    status: response.status,
    contentType,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}
