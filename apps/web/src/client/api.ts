import { z } from "zod";
import {
  ApiErrorV1Schema,
  BootstrapResponseV1Schema,
  ImageInputResponseV1Schema,
  JobActionRequestV1Schema,
  JobEventV1Schema,
  JobResponseV1Schema,
  ProjectSummaryV1Schema,
  RenderActionRequestV1Schema,
  RenderResponseV1Schema,
  SessionResponseV1Schema,
  StartJobRequestV1Schema,
  StartRenderRequestV1Schema,
  type PublicStartJobRequestV1,
  type ImageInputV1,
  type StartRenderRequestV1,
} from "../shared";

const SESSION_STORAGE_KEY = "sequences.local-session.v1";

export type WorkspaceBootstrap = z.infer<typeof BootstrapResponseV1Schema>;
export type ProjectSummary = z.infer<typeof ProjectSummaryV1Schema>;
export type JobResponse = z.infer<typeof JobResponseV1Schema>;
export type JobEvent = z.infer<typeof JobEventV1Schema>;
export type RenderResponse = z.infer<typeof RenderResponseV1Schema>;

export class MissingLocalSessionError extends Error {
  constructor() {
    super(
      "Open the exact localhost URL printed by the Sequences server. It includes a one-time boot token.",
    );
    this.name = "MissingLocalSessionError";
  }
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly requestId: string | null;

  constructor(message: string, code = "request_failed", requestId: string | null = null) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.requestId = requestId;
  }
}

interface StoredSession {
  version: "sequences.session.v1";
  csrfToken: string;
  expiresAt: string;
}

export class SequencesApi {
  private constructor(private readonly csrfToken: string) {}

  static restore(): SequencesApi | null {
    let parsed: unknown;
    try {
      const value = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!value) return null;
      parsed = JSON.parse(value);
    } catch {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }

    const session = SessionResponseV1Schema.safeParse(parsed);
    if (!session.success || Date.parse(session.data.expiresAt) <= Date.now()) {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return new SequencesApi(session.data.csrfToken);
  }

  static async establish(bootToken: string): Promise<SequencesApi> {
    const response = await fetch("/api/v1/session", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "sequences.create-session.v1",
        bootToken,
      }),
    });
    const session = await parseResponse(response, SessionResponseV1Schema);
    const stored: StoredSession = session;
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(stored));
    return new SequencesApi(session.csrfToken);
  }

  async bootstrap(): Promise<WorkspaceBootstrap> {
    return this.get("/api/v1/bootstrap", BootstrapResponseV1Schema);
  }

  async getJob(jobId: string): Promise<JobResponse> {
    return this.get(`/api/v1/jobs/${encodeURIComponent(jobId)}`, JobResponseV1Schema);
  }

  async getRender(renderId: string): Promise<RenderResponse> {
    return this.get(`/api/v1/renders/${encodeURIComponent(renderId)}`, RenderResponseV1Schema);
  }

  async uploadImage(projectId: string, file: File): Promise<ImageInputV1> {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/images`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": file.type || "application/octet-stream",
        "X-Sequences-CSRF": this.csrfToken,
      },
      body: file,
    });
    return (await parseResponse(response, ImageInputResponseV1Schema)).image;
  }

  async discardImage(projectId: string, path: string): Promise<void> {
    const response = await fetch(
      `/api/v1/projects/${encodeURIComponent(projectId)}/images?path=${encodeURIComponent(path)}`,
      {
        method: "DELETE",
        credentials: "include",
        headers: { "X-Sequences-CSRF": this.csrfToken },
      },
    );
    if (!response.ok) await parseResponse(response, z.never());
  }

  async startRender(projectId: string, request: StartRenderRequestV1): Promise<RenderResponse> {
    const body = StartRenderRequestV1Schema.parse(request);
    return this.mutate(
      `/api/v1/projects/${encodeURIComponent(projectId)}/renders`,
      body,
      RenderResponseV1Schema,
    );
  }

  async cancelRender(renderId: string): Promise<RenderResponse> {
    const body = RenderActionRequestV1Schema.parse({ version: "sequences.render-action.v1" });
    return this.mutate(
      `/api/v1/renders/${encodeURIComponent(renderId)}/cancel`,
      body,
      RenderResponseV1Schema,
    );
  }

  async startJob(projectId: string, request: PublicStartJobRequestV1): Promise<JobResponse> {
    const body = StartJobRequestV1Schema.parse(request);
    return this.mutate(
      `/api/v1/projects/${encodeURIComponent(projectId)}/jobs`,
      body,
      JobResponseV1Schema,
    );
  }

  async cancelJob(jobId: string): Promise<JobResponse> {
    const body = JobActionRequestV1Schema.parse({
      version: "sequences.job-action.v1",
    });
    return this.mutate(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
      body,
      JobResponseV1Schema,
    );
  }

  subscribeToJob(
    eventsUrl: string,
    onEvent: (event: JobEvent) => void,
    onConnectionError: () => void,
  ): () => void {
    const source = new EventSource(eventsUrl, { withCredentials: true });
    const handleEvent = (message: MessageEvent<string>) => {
      try {
        onEvent(JobEventV1Schema.parse(JSON.parse(message.data)));
      } catch {
        // An invalid event is ignored; polling remains the recovery path and no
        // untrusted event text is rendered into the authoring transcript.
      }
    };
    source.addEventListener("job", handleEvent as EventListener);
    source.addEventListener("error", onConnectionError);
    return () => {
      source.removeEventListener("job", handleEvent as EventListener);
      source.removeEventListener("error", onConnectionError);
      source.close();
    };
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const response = await fetch(path, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        return await parseResponse(response, schema);
      } catch (error) {
        const retryable =
          error instanceof TypeError ||
          (error instanceof ApiRequestError && error.code === "unreadable_response");
        if (!retryable || attempt === 8) throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 250, 1_000)));
      }
    }
    throw lastError;
  }

  private async mutate<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Sequences-CSRF": this.csrfToken,
      },
      body: JSON.stringify(body),
    });
    return parseResponse(response, schema);
  }
}

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiRequestError(
      response.ok
        ? "The local server returned an unreadable response."
        : `The local server rejected the request (${String(response.status)}).`,
      response.ok ? "unreadable_response" : "request_failed",
    );
  }

  if (!response.ok) {
    const problem = ApiErrorV1Schema.safeParse(body);
    if (problem.success) {
      throw new ApiRequestError(
        problem.data.error.message,
        problem.data.error.code,
        problem.data.error.requestId,
      );
    }
    throw new ApiRequestError(
      `The local server rejected the request (${String(response.status)}).`,
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiRequestError(
      "The local server response did not match the pinned Sequences contract.",
    );
  }
  return parsed.data;
}
