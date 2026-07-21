import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  CreateSessionRequestV1Schema,
  JobActionRequestV1Schema,
  MUTABLE_JOB_STATES,
  PROJECT_ID,
  RenderActionRequestV1Schema,
  StartRenderRequestV1Schema,
  StartJobRequestV1Schema,
  TERMINAL_JOB_STATES,
  type BootstrapResponseV1,
  type JobState,
} from "../shared";
import { CapabilityCatalog } from "./capabilities";
import { CodexRunner } from "./codex-runner";
import { serveClientShell } from "./client-shell";
import { createServerConfig, type ServerConfig, type ServerConfigOverrides } from "./config";
import { ApiProblem, errorMessage, problemResponse } from "./errors";
import { HyperframesVerifier } from "./hyperframes";
import { readBoundedImageBody } from "./image-input";
import { JobManager } from "./job-manager";
import { parseJsonBody } from "./json-body";
import { ProjectStore } from "./project-store";
import { RenderManager } from "./render-manager";
import { RunStore } from "./run-store";
import { LocalSecurity } from "./security";
import { SkillBundle } from "./skills";
import { serveDownload, serveProjectFile, staticPreflight } from "./static-files";
import { readSequenceArtifact } from "./sequence-artifact";

type AppEnvironment = { Variables: { requestId: string } };

export const JOB_EVENT_HEARTBEAT_MS = 15_000;

export interface SequencesRuntime {
  app: Hono<AppEnvironment>;
  config: ServerConfig;
  projects: ProjectStore;
  jobs: JobManager;
  renders: RenderManager;
  security: LocalSecurity;
}

export async function createSequencesRuntime(
  overrides: ServerConfigOverrides = {},
): Promise<SequencesRuntime> {
  const config = createServerConfig(overrides);
  const projects = new ProjectStore(config);
  await projects.initialize();
  const runs = new RunStore(projects);
  const skills = new SkillBundle(config);
  const capabilities = new CapabilityCatalog(config, skills);
  const codex = new CodexRunner(config);
  const hyperframes = new HyperframesVerifier(config);
  const jobs = new JobManager(config, projects, runs, skills, codex, hyperframes);
  await jobs.recoverInterruptedJobs();
  const renders = new RenderManager(config, projects, hyperframes);
  await renders.initialize();
  const security = new LocalSecurity(config);
  const app = new Hono<AppEnvironment>();

  app.use("*", async (c, next) => {
    c.set("requestId", randomUUID());
    await next();
  });
  app.use("*", security.middleware());

  app.onError((error, c) => {
    if (error instanceof ApiProblem) return problemResponse(c, error);
    if (error instanceof z.ZodError) {
      return problemResponse(
        c,
        new ApiProblem(500, "contract_violation", "A persisted or upstream contract was invalid"),
      );
    }
    console.error("[sequences] request failed", errorMessage(error));
    return problemResponse(
      c,
      new ApiProblem(500, "internal_error", "The local server could not complete this request"),
    );
  });
  app.notFound((c) =>
    problemResponse(c, new ApiProblem(404, "route_not_found", "Route not found")),
  );

  app.get("/api/v1/health", (c) =>
    c.json({ version: "sequences.health.v1", ok: true, projectId: PROJECT_ID }),
  );
  app.get("/favicon.ico", (c) => c.body(null, 204));

  app.post("/api/v1/session", async (c) => {
    const body = await parseJsonBody(c.req.raw, CreateSessionRequestV1Schema, config.maxJsonBytes);
    if (!security.acceptsBootToken(body.bootToken)) {
      throw new ApiProblem(401, "invalid_boot_token", "The local boot token is invalid");
    }
    c.header("Set-Cookie", security.sessionCookie());
    return c.json({
      version: "sequences.session.v1" as const,
      csrfToken: security.csrfToken(),
      expiresAt: config.sessionExpiresAt.toISOString(),
    });
  });

  app.get("/api/v1/bootstrap", async (c) => {
    const project = await projectSummary(config, projects, jobs, renders);
    const immutableSampleUrl = sampleUrl(config);
    const response: BootstrapResponseV1 = {
      version: "sequences.bootstrap.v1",
      project,
      capabilities: await capabilities.discover(),
      sampleUrl: immutableSampleUrl,
    };
    return c.json(response);
  });

  app.get("/api/v1/projects", async (c) =>
    c.json({
      version: "sequences.projects.v1" as const,
      projects: [await projectSummary(config, projects, jobs, renders)],
    }),
  );

  app.get("/api/v1/projects/:projectId", async (c) => {
    assertProject(c.req.param("projectId"));
    return c.json(await projectSummary(config, projects, jobs, renders));
  });

  app.get("/api/v1/capabilities", async (c) => c.json(await capabilities.discover()));

  app.post("/api/v1/projects/:projectId/images", async (c) => {
    assertProject(c.req.param("projectId"));
    const bytes = await readBoundedImageBody(c.req.raw);
    const image = await projects.storeImageInput(bytes, c.req.header("content-type") ?? null);
    return c.json({ version: "sequences.image-input.v1" as const, image }, 201);
  });

  app.delete("/api/v1/projects/:projectId/images", async (c) => {
    assertProject(c.req.param("projectId"));
    const path = c.req.query("path");
    if (!path) throw new ApiProblem(400, "image_input_path_required", "Image path is required");
    await projects.discardImageInput(path);
    return c.body(null, 204);
  });

  app.post("/api/v1/projects/:projectId/jobs", async (c) => {
    const projectId = c.req.param("projectId");
    assertProject(projectId);
    const body = await parseJsonBody(c.req.raw, StartJobRequestV1Schema, config.maxJsonBytes);
    return c.json(await jobs.start(projectId, body), 202);
  });

  app.get("/api/v1/jobs/:jobId", async (c) => c.json(await jobs.get(c.req.param("jobId"))));

  app.get("/api/v1/jobs/:jobId/events", async (c) => {
    const jobId = c.req.param("jobId");
    await jobs.get(jobId);
    const requestedAfter = c.req.query("after") ?? c.req.header("last-event-id") ?? "0";
    const after = Number(requestedAfter);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new ApiProblem(
        400,
        "invalid_event_cursor",
        "SSE event cursor must be a non-negative integer",
      );
    }
    return streamSSE(c, async (stream) => {
      let cursor = after;
      let lastHeartbeat = Date.now();
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      while (!aborted) {
        const events = await jobs.events(jobId, cursor);
        for (const event of events) {
          await stream.writeSSE({
            event: "job",
            id: String(event.sequence),
            data: JSON.stringify(event),
          });
          cursor = event.sequence;
        }
        const receipt = (await jobs.get(jobId)).receipt;
        if (TERMINAL_JOB_STATES.has(receipt.state)) break;
        if (Date.now() - lastHeartbeat >= JOB_EVENT_HEARTBEAT_MS) {
          await stream.write(": heartbeat\n\n");
          lastHeartbeat = Date.now();
        }
        await stream.sleep(250);
      }
    });
  });

  app.post("/api/v1/jobs/:jobId/cancel", async (c) => {
    await parseJsonBody(c.req.raw, JobActionRequestV1Schema, config.maxJsonBytes);
    return c.json(await jobs.cancel(c.req.param("jobId")));
  });
  app.post("/api/v1/projects/:projectId/renders", async (c) => {
    const projectId = c.req.param("projectId");
    assertProject(projectId);
    const body = await parseJsonBody(c.req.raw, StartRenderRequestV1Schema, config.maxJsonBytes);
    return c.json(await renders.start(projectId, body), 202);
  });
  app.get("/api/v1/renders/:renderId", async (c) =>
    c.json(await renders.get(c.req.param("renderId"))),
  );
  app.post("/api/v1/renders/:renderId/cancel", async (c) => {
    await parseJsonBody(c.req.raw, RenderActionRequestV1Schema, config.maxJsonBytes);
    return c.json(await renders.cancel(c.req.param("renderId")));
  });
  app.on(["GET", "HEAD"], "/api/v1/renders/:renderId/video", async (c) => {
    const artifact = await renders.artifact(c.req.param("renderId"), "video");
    return serveDownload(c, artifact.path, artifact.filename, artifact.contentType);
  });
  app.on(["GET", "HEAD"], "/api/v1/renders/:renderId/source", async (c) => {
    const artifact = await renders.artifact(c.req.param("renderId"), "source");
    return serveDownload(c, artifact.path, artifact.filename, artifact.contentType);
  });

  const staticRoutes = [
    "/api/v1/projects/:projectId/files/:token/accepted/*",
    "/api/v1/projects/:projectId/files/:token/sample/*",
    "/api/v1/projects/:projectId/files/:token/candidate/:jobId/*",
  ] as const;
  for (const route of staticRoutes) app.options(route, (c) => staticPreflight(c));
  app.on(["GET", "HEAD"], staticRoutes[0], async (c) => {
    assertStaticAccess(c.req.param("projectId"), c.req.param("token"), security);
    return serveProjectFile(
      c,
      config,
      projects.acceptedRoot(PROJECT_ID),
      staticRouteTail(c.req.url, "/accepted/"),
    );
  });
  app.on(["GET", "HEAD"], staticRoutes[1], async (c) => {
    assertStaticAccess(c.req.param("projectId"), c.req.param("token"), security);
    return serveProjectFile(c, config, config.seedRoot, staticRouteTail(c.req.url, "/sample/"));
  });
  app.on(["GET", "HEAD"], staticRoutes[2], async (c) => {
    assertStaticAccess(c.req.param("projectId"), c.req.param("token"), security);
    await jobs.get(c.req.param("jobId"));
    return serveProjectFile(
      c,
      config,
      projects.candidateRoot(c.req.param("jobId")),
      staticRouteTail(c.req.url, `/candidate/${encodeURIComponent(c.req.param("jobId"))}/`),
    );
  });

  app.on(["GET", "HEAD"], "*", async (c) => {
    if (c.req.path.startsWith("/api/"))
      throw new ApiProblem(404, "route_not_found", "Route not found");
    return serveClientShell(c, config);
  });

  return { app, config, projects, jobs, renders, security };
}

export async function createSequencesApp(
  overrides: ServerConfigOverrides = {},
): Promise<Hono<AppEnvironment>> {
  return (await createSequencesRuntime(overrides)).app;
}

async function projectSummary(
  config: ServerConfig,
  projects: ProjectStore,
  jobs: JobManager,
  renders: RenderManager,
) {
  const receipts = await jobs.listReceipts();
  const renderReceipts = await renders.listReceipts();
  const acceptedCommit = await projects.acceptedCommit();
  const acceptedRun = receipts.find(
    (receipt) => receipt.state === "applied" && receipt.acceptedCommit === acceptedCommit,
  );
  const director = await jobs.directorSummary();
  return {
    version: "sequences.project-summary.v1" as const,
    id: PROJECT_ID,
    title: config.projectTitle,
    acceptedCommit,
    acceptedSource: acceptedRun
      ? {
          kind: "generated_candidate" as const,
          label: "Current generated video",
          runId: acceptedRun.jobId,
        }
      : { kind: "prepared_sample" as const, label: "Prepared sample", runId: null },
    acceptedUrl: acceptedUrl(config),
    sampleUrl: sampleUrl(config),
    files: await projects.listFiles(),
    sequence: await readSequenceArtifact(projects.acceptedRoot(PROJECT_ID), false),
    director: {
      generation: director.generation,
      active: directorSessionIsActive(receipts),
    },
    jobs: receipts.map((receipt) => ({
      id: receipt.jobId,
      state: receipt.state,
      kind: receipt.kind,
      createdAt: receipt.createdAt,
    })),
    renders: renderReceipts.map((receipt) => ({
      id: receipt.renderId,
      state: receipt.state,
      acceptedCommit: receipt.acceptedCommit,
      createdAt: receipt.createdAt,
    })),
  };
}

export function directorSessionIsActive(receipts: readonly { state: JobState }[]): boolean {
  return receipts.some((receipt) => MUTABLE_JOB_STATES.has(receipt.state));
}

function assertProject(projectId: string): asserts projectId is typeof PROJECT_ID {
  if (projectId !== PROJECT_ID) throw new ApiProblem(404, "project_not_found", "Project not found");
}

function assertStaticAccess(projectId: string, token: string, security: LocalSecurity): void {
  assertProject(projectId);
  if (!security.acceptsStaticToken(token))
    throw new ApiProblem(404, "file_not_found", "Project file not found");
}

function staticRouteTail(requestUrl: string, boundary: string): string {
  const pathname = new URL(requestUrl).pathname;
  const boundaryAt = pathname.indexOf(boundary);
  if (boundaryAt < 0) throw new ApiProblem(404, "file_not_found", "Project file not found");
  return pathname.slice(boundaryAt + boundary.length) || "index.html";
}

function acceptedUrl(config: ServerConfig): string {
  return `/api/v1/projects/${PROJECT_ID}/files/${config.staticAccessToken}/accepted/index.html`;
}

function sampleUrl(config: ServerConfig): string {
  return `/api/v1/projects/${PROJECT_ID}/files/${config.staticAccessToken}/sample/index.html`;
}
