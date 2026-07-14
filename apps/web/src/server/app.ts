import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  CreateSessionRequestV1Schema,
  JobActionRequestV1Schema,
  PROJECT_ID,
  StartJobRequestV1Schema,
  TERMINAL_JOB_STATES,
  type BootstrapResponseV1,
} from "../shared";
import { CapabilityCatalog } from "./capabilities";
import { CodexRunner } from "./codex-runner";
import { serveClientShell } from "./client-shell";
import { createServerConfig, type ServerConfig, type ServerConfigOverrides } from "./config";
import { ApiProblem, errorMessage, problemResponse } from "./errors";
import { HyperframesVerifier } from "./hyperframes";
import { JobManager } from "./job-manager";
import { parseJsonBody } from "./json-body";
import { ProjectStore } from "./project-store";
import { RunStore } from "./run-store";
import { LocalSecurity } from "./security";
import { SkillBundle } from "./skills";
import { serveProjectFile, staticPreflight } from "./static-files";

type AppEnvironment = { Variables: { requestId: string } };

export interface SequencesRuntime {
  app: Hono<AppEnvironment>;
  config: ServerConfig;
  projects: ProjectStore;
  jobs: JobManager;
  security: LocalSecurity;
}

export async function createSequencesRuntime(overrides: ServerConfigOverrides = {}): Promise<SequencesRuntime> {
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
      return problemResponse(c, new ApiProblem(500, "contract_violation", "A persisted or upstream contract was invalid"));
    }
    console.error("[sequences] request failed", errorMessage(error));
    return problemResponse(c, new ApiProblem(500, "internal_error", "The local server could not complete this request"));
  });
  app.notFound((c) => problemResponse(c, new ApiProblem(404, "route_not_found", "Route not found")));

  app.get("/api/v1/health", (c) =>
    c.json({ version: "sequences.health.v1", ok: true, projectId: PROJECT_ID }),
  );

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
    const project = await projectSummary(config, projects, jobs);
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
      projects: [await projectSummary(config, projects, jobs)],
    }),
  );

  app.get("/api/v1/projects/:projectId", async (c) => {
    assertProject(c.req.param("projectId"));
    return c.json(await projectSummary(config, projects, jobs));
  });

  app.get("/api/v1/capabilities", async (c) => c.json(await capabilities.discover()));

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
      throw new ApiProblem(400, "invalid_event_cursor", "SSE event cursor must be a non-negative integer");
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
        if (receipt.state === "review_ready" || TERMINAL_JOB_STATES.has(receipt.state)) break;
        if (Date.now() - lastHeartbeat >= 15_000) {
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
  app.post("/api/v1/jobs/:jobId/apply", async (c) => {
    const body = await parseJsonBody(c.req.raw, JobActionRequestV1Schema, config.maxJsonBytes);
    return c.json(await jobs.apply(c.req.param("jobId"), body.reason));
  });
  app.post("/api/v1/jobs/:jobId/reject", async (c) => {
    const body = await parseJsonBody(c.req.raw, JobActionRequestV1Schema, config.maxJsonBytes);
    return c.json(await jobs.reject(c.req.param("jobId"), body.reason));
  });

  const staticRoutes = [
    "/api/v1/projects/:projectId/files/:token/accepted/*",
    "/api/v1/projects/:projectId/files/:token/sample/*",
    "/api/v1/projects/:projectId/files/:token/candidate/:jobId/*",
  ] as const;
  for (const route of staticRoutes) app.options(route, (c) => staticPreflight(c));
  app.on(["GET", "HEAD"], staticRoutes[0], async (c) => {
    assertStaticAccess(c.req.param("projectId"), c.req.param("token"), security);
    return serveProjectFile(c, config, projects.acceptedRoot(PROJECT_ID), c.req.param("*") ?? "index.html");
  });
  app.on(["GET", "HEAD"], staticRoutes[1], async (c) => {
    assertStaticAccess(c.req.param("projectId"), c.req.param("token"), security);
    return serveProjectFile(c, config, config.seedRoot, c.req.param("*") ?? "index.html");
  });
  app.on(["GET", "HEAD"], staticRoutes[2], async (c) => {
    assertStaticAccess(c.req.param("projectId"), c.req.param("token"), security);
    await jobs.get(c.req.param("jobId"));
    return serveProjectFile(c, config, projects.candidateRoot(c.req.param("jobId")), c.req.param("*") ?? "index.html");
  });

  app.on(["GET", "HEAD"], "*", async (c) => {
    if (c.req.path.startsWith("/api/")) throw new ApiProblem(404, "route_not_found", "Route not found");
    return serveClientShell(c, config);
  });

  return { app, config, projects, jobs, security };
}

export async function createSequencesApp(overrides: ServerConfigOverrides = {}): Promise<Hono<AppEnvironment>> {
  return (await createSequencesRuntime(overrides)).app;
}

async function projectSummary(config: ServerConfig, projects: ProjectStore, jobs: JobManager) {
  const receipts = await jobs.listReceipts();
  return {
    version: "sequences.project-summary.v1" as const,
    id: PROJECT_ID,
    title: config.projectTitle,
    acceptedCommit: await projects.acceptedCommit(),
    acceptedUrl: acceptedUrl(config),
    sampleUrl: sampleUrl(config),
    files: await projects.listFiles(),
    jobs: receipts.map((receipt) => ({
      id: receipt.jobId,
      state: receipt.state,
      kind: receipt.kind,
      createdAt: receipt.createdAt,
    })),
  };
}

function assertProject(projectId: string): asserts projectId is typeof PROJECT_ID {
  if (projectId !== PROJECT_ID) throw new ApiProblem(404, "project_not_found", "Project not found");
}

function assertStaticAccess(projectId: string, token: string, security: LocalSecurity): void {
  assertProject(projectId);
  if (!security.acceptsStaticToken(token)) throw new ApiProblem(404, "file_not_found", "Project file not found");
}

function acceptedUrl(config: ServerConfig): string {
  return `/api/v1/projects/${PROJECT_ID}/files/${config.staticAccessToken}/accepted/index.html`;
}

function sampleUrl(config: ServerConfig): string {
  return `/api/v1/projects/${PROJECT_ID}/files/${config.staticAccessToken}/sample/index.html`;
}
