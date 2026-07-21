import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSequencesRuntime } from "../../src/server/app";

const workspaces: string[] = [];
const ORIGIN = "http://127.0.0.1:4317";
const HOST = "127.0.0.1:4317";
const PREVIEW_ORIGIN = "http://localhost:4317";
const PREVIEW_HOST = "localhost:4317";

afterEach(() => {
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function runtime() {
  const workspace = mkdtempSync(join(tmpdir(), "sequences-security-"));
  workspaces.push(workspace);
  const root = process.cwd();
  return createSequencesRuntime({
    workspaceRoot: root,
    acceptedRoot: join(workspace, "accepted"),
    seedRoot: join(root, "fixtures", "release-a"),
    candidatesRoot: join(workspace, "candidates"),
    runsRoot: join(workspace, "runs"),
    rendersRoot: join(workspace, "renders"),
    renderWorktreesRoot: join(workspace, "render-worktrees"),
    skillsRoot: join(root, ".agents", "skills"),
    skillsManifestPath: join(root, ".agents", "skills-manifest.json"),
    registryManifestPath: join(root, ".agents", "registry", "registry.json"),
    expectedOrigin: ORIGIN,
    expectedHost: HOST,
    bootToken: "b".repeat(43),
    sessionToken: "s".repeat(43),
    csrfToken: "c".repeat(43),
    staticAccessToken: "f".repeat(43),
  });
}

function headers(extra: Record<string, string> = {}): HeadersInit {
  return { Host: HOST, ...extra };
}

describe("localhost security boundary", () => {
  it("serves the shell publicly but keeps project APIs behind a session", async () => {
    const { app } = await runtime();
    const shell = await app.request("/", { headers: headers() });
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await shell.text()).toContain('<div id="root"></div>');

    const bootstrap = await app.request("/api/v1/bootstrap", { headers: headers() });
    expect(bootstrap.status).toBe(401);
  });

  it("exchanges the boot token only from the exact origin", async () => {
    const { app } = await runtime();
    const missingOrigin = await app.request("/api/v1/session", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        version: "sequences.create-session.v1",
        bootToken: "b".repeat(43),
      }),
    });
    expect(missingOrigin.status).toBe(403);

    const response = await app.request("/api/v1/session", {
      method: "POST",
      headers: headers({ Origin: ORIGIN, "Content-Type": "application/json" }),
      body: JSON.stringify({
        version: "sequences.create-session.v1",
        bootToken: "b".repeat(43),
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(
      /^sequences_session=.*; HttpOnly; SameSite=Strict; Path=\//,
    );
  });

  it("requires both the session cookie and CSRF token for mutations", async () => {
    const { app } = await runtime();
    const response = await app.request("/api/v1/projects/release-a/jobs", {
      method: "POST",
      headers: headers({
        Origin: ORIGIN,
        Cookie: `sequences_session=${"s".repeat(43)}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        version: "sequences.start-job.v1",
        kind: "plan",
        prompt: "A bounded test prompt",
      }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_csrf" } });
  });

  it("serves signed composition files on an isolated origin with the player sandbox contract", async () => {
    const { app } = await runtime();
    const response = await app.request(
      `/api/v1/projects/release-a/files/${"f".repeat(43)}/sample/index.html`,
      { headers: { Host: PREVIEW_HOST, Origin: PREVIEW_ORIGIN } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(PREVIEW_ORIGIN);
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("sandbox allow-scripts allow-same-origin");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain(ORIGIN);
    expect(await response.text()).toContain('data-composition-id="release-a"');
  });

  it("does not expose the app shell or authenticated API on the preview origin", async () => {
    const { app } = await runtime();
    const shell = await app.request("/", { headers: { Host: PREVIEW_HOST } });
    const bootstrap = await app.request("/api/v1/bootstrap", {
      headers: { Host: PREVIEW_HOST, Origin: PREVIEW_ORIGIN },
    });

    expect(shell.status).toBe(403);
    expect(bootstrap.status).toBe(403);
  });

  it("serves nested composition assets instead of substituting the project index", async () => {
    const { app } = await runtime();
    const response = await app.request(
      `/api/v1/projects/release-a/files/${"f".repeat(43)}/sample/assets/vendor/gsap.min.js`,
      { headers: headers({ Origin: "null" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toContain("GreenSock");
  });

  it("rejects an alternate host before routing", async () => {
    const { app } = await runtime();
    const response = await app.request("/api/v1/health", {
      headers: { Host: "localhost:4317" },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_host" } });
  });
});
