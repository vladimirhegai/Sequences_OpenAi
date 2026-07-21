import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BootstrapResponseV1Schema,
  ImageInputResponseV1Schema,
  JobResponseV1Schema,
  RenderReceiptV1Schema,
  RenderResponseV1Schema,
  RunReceiptV1Schema,
  SessionResponseV1Schema,
  TERMINAL_JOB_STATES,
  type RenderResponseV1,
} from "../apps/web/src/shared";

type JobResponseV1 = z.infer<typeof JobResponseV1Schema>;

const LocalServerDescriptorSchema = z
  .object({
    version: z.literal("sequences.local-server.v1"),
    origin: z.string().url(),
    bootToken: z.string().min(32).max(256),
    pid: z.number().int().positive(),
    startedAt: z.string().datetime(),
  })
  .strict();

export const GenerateCliResultV1Schema = z
  .object({
    version: z.literal("sequences.generate-cli-result.v1"),
    jobId: z.string().regex(/^run_[0-9a-f]{32}$/),
    state: z.literal("applied"),
    candidateUrl: z.string().url(),
    candidateCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
    acceptedCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
    changedFiles: z.array(z.string().min(1)),
    finalArtifacts: z.array(z.string().min(1)),
    qa: z.object({
      errorCount: z.number().int().nonnegative(),
      warningCount: z.number().int().nonnegative(),
      infoCount: z.number().int().nonnegative(),
    }),
    execution: z
      .object({
        model: z.string().min(1),
        reasoningEffort: z.string().min(1),
        sandbox: z.enum(["workspace-write", "danger-full-access"]),
      })
      .strict(),
    runReceiptPath: z.string().min(1),
    renderReceiptPath: z.string().min(1).nullable(),
    render: RenderReceiptV1Schema.nullable(),
    jobReceipt: RunReceiptV1Schema,
  })
  .strict();

export type GenerateCliResultV1 = z.infer<typeof GenerateCliResultV1Schema>;

export interface GenerateOptions {
  prompt: string;
  imageFiles: string[];
  renderQuality: "draft" | "standard" | "high" | null;
  timeoutMinutes: number;
}

const REQUIRED_AUTHORED_ARTIFACTS = [
  "sequence.json",
  "frame.md",
  "story/design-capsule.json",
  "story/component-plan.json",
  "index.motion.json",
] as const;

const scriptDirectory = import.meta.dir ?? dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");

export async function runGenerate(options: GenerateOptions): Promise<GenerateCliResultV1> {
  if (!options.prompt) throw new Error("A non-empty video prompt is required");
  if (options.imageFiles.length > 4) throw new Error("At most four --image inputs are supported");

  const descriptor = LocalServerDescriptorSchema.parse(
    JSON.parse(await readFile(resolve(root, "data", "local-server.json"), "utf8")) as unknown,
  );
  const origin = descriptor.origin.replace(/\/$/, "");

  const health = await fetch(`${origin}/api/v1/health`);
  if (!health.ok) {
    throw new Error(
      `The website server at ${origin} is not healthy. Start it with "bun run dev" first.`,
    );
  }

  const sessionResponse = await fetch(`${origin}/api/v1/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      version: "sequences.create-session.v1",
      bootToken: descriptor.bootToken,
    }),
  });
  const session = await responseJson(sessionResponse, SessionResponseV1Schema);
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("The website server did not establish a local CLI session");

  const readHeaders = { Accept: "application/json", Cookie: cookie };
  const mutationHeaders = {
    ...readHeaders,
    Origin: origin,
    "Content-Type": "application/json",
    "X-Sequences-CSRF": session.csrfToken,
  };

  const bootstrap = await responseJson(
    await resilientGet("/api/v1/bootstrap"),
    BootstrapResponseV1Schema,
  );
  const imagePaths: string[] = [];
  for (const imageFile of options.imageFiles) {
    const absolutePath = resolve(imageFile);
    const bytes = await readFile(absolutePath);
    const mediaType = imageMediaTypeForPath(absolutePath);
    const uploaded = await responseJson(
      await fetch(`${origin}/api/v1/projects/release-a/images`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Cookie: cookie,
          Origin: origin,
          "Content-Type": mediaType,
          "X-Sequences-CSRF": session.csrfToken,
        },
        body: bytes,
      }),
      ImageInputResponseV1Schema,
    );
    imagePaths.push(uploaded.image.path);
    console.error(`uploaded · ${imageFile} -> ${uploaded.image.path}`);
  }

  let activeJobId: string | null = null;
  let activeRenderId: string | null = null;
  let interrupting = false;
  const onInterrupt = (): void => {
    if (interrupting) return;
    interrupting = true;
    const path = activeJobId
      ? `/api/v1/jobs/${activeJobId}/cancel`
      : activeRenderId
        ? `/api/v1/renders/${activeRenderId}/cancel`
        : null;
    if (!path) process.exit(130);
    console.error(
      activeJobId
        ? `Cancelling ${activeJobId} through the website API…`
        : `Cancelling ${activeRenderId!} through the website API…`,
    );
    void fetch(`${origin}${path}`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        version: activeJobId ? "sequences.job-action.v1" : "sequences.render-action.v1",
      }),
    }).finally(() => process.exit(130));
  };
  process.once("SIGINT", onInterrupt);

  try {
    const started = await responseJson(
      await fetch(`${origin}/api/v1/projects/release-a/jobs`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          version: "sequences.start-job.v1",
          kind: "build",
          prompt: options.prompt,
          baseCommit: bootstrap.project.acceptedCommit,
          directorMode: "reset",
          ...(imagePaths.length > 0 ? { imagePaths } : {}),
        }),
      }),
      JobResponseV1Schema,
    );
    activeJobId = started.receipt.jobId;
    const job = await waitForJob(started, options, origin, readHeaders, mutationHeaders);
    const runReceiptPath = runReceiptPathFor(job.receipt.jobId);

    if (job.receipt.state !== "applied") {
      throw new Error(
        `${job.receipt.error?.message ?? `Generation ended in ${job.receipt.state}`}\nRun receipt: ${runReceiptPath}`,
      );
    }
    activeJobId = null;
    assertAppliedResult(job, runReceiptPath);

    let render: RenderResponseV1 | null = null;
    if (options.renderQuality) {
      render = await responseJson(
        await fetch(`${origin}/api/v1/projects/release-a/renders`, {
          method: "POST",
          headers: mutationHeaders,
          body: JSON.stringify({
            version: "sequences.start-render.v1",
            quality: options.renderQuality,
          }),
        }),
        RenderResponseV1Schema,
      );
      activeRenderId = render.receipt.renderId;
      render = await waitForRender(render, origin, readHeaders, mutationHeaders);
      activeRenderId = null;
      if (render.receipt.state !== "completed" || !render.receipt.artifacts) {
        throw new Error(
          `${render.receipt.error?.message ?? `Render ended in ${render.receipt.state}`}\nRender receipt: ${renderReceiptPathFor(render.receipt.renderId)}`,
        );
      }
    }

    const sandbox = sandboxFrom(job.receipt.sanitizedArguments);
    const result = GenerateCliResultV1Schema.parse({
      version: "sequences.generate-cli-result.v1",
      jobId: job.receipt.jobId,
      state: job.receipt.state,
      candidateUrl: new URL(job.candidateUrl, origin).toString(),
      candidateCommit: job.receipt.candidateCommit,
      acceptedCommit: job.receipt.acceptedCommit,
      changedFiles: job.receipt.changedFiles,
      finalArtifacts: job.receipt.final?.artifacts ?? [],
      qa: job.receipt.qa?.summary,
      execution: {
        model: job.receipt.model,
        reasoningEffort: job.receipt.reasoningEffort,
        sandbox,
      },
      runReceiptPath,
      renderReceiptPath: render ? renderReceiptPathFor(render.receipt.renderId) : null,
      render: render?.receipt ?? null,
      jobReceipt: job.receipt,
    });
    return result;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }

  async function resilientGet(path: string): Promise<Response> {
    const maxAttempts = 60;
    let lastStatus = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(`${origin}${path}`, { headers: readHeaders });
        lastStatus = response.status;
        const body = await response.text();
        try {
          JSON.parse(body);
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch {
          // A busy local development server can occasionally close an otherwise
          // successful GET before the JSON body is complete. Mutations are never
          // retried; read-only receipt polling is safe to repeat.
        }
      } catch {
        // The server may briefly stop accepting reads while a browser QA process
        // starts. The caller's job/render deadline remains authoritative.
      }
      if (attempt < maxAttempts) await Bun.sleep(Math.min(attempt * 250, 1_000));
    }
    throw new Error(
      `Website API returned HTTP ${lastStatus} with unreadable JSON after ${maxAttempts} read retries`,
    );
  }
}

async function waitForJob(
  initial: JobResponseV1,
  options: GenerateOptions,
  origin: string,
  readHeaders: HeadersInit,
  mutationHeaders: HeadersInit,
): Promise<JobResponseV1> {
  let current = initial;
  let status = "";
  const deadline = Date.now() + options.timeoutMinutes * 60_000;
  while (!TERMINAL_JOB_STATES.has(current.receipt.state)) {
    const nextStatus = `${current.receipt.state}:${current.receipt.updatedAt}`;
    if (nextStatus !== status) {
      status = nextStatus;
      console.error(`${current.receipt.state} · ${current.receipt.jobId}`);
    }
    if (Date.now() >= deadline) {
      await fetch(`${origin}/api/v1/jobs/${current.receipt.jobId}/cancel`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ version: "sequences.job-action.v1" }),
      });
      throw new Error(
        `Generation exceeded ${options.timeoutMinutes} minutes and was cancelled\nRun receipt: ${runReceiptPathFor(current.receipt.jobId)}`,
      );
    }
    await Bun.sleep(1_000);
    current = await responseJson(
      await resilientGetFrom(origin, `/api/v1/jobs/${current.receipt.jobId}`, readHeaders),
      JobResponseV1Schema,
    );
  }
  console.error(`${current.receipt.state} · ${current.receipt.jobId}`);
  return current;
}

async function waitForRender(
  initial: RenderResponseV1,
  origin: string,
  readHeaders: HeadersInit,
  mutationHeaders: HeadersInit,
): Promise<RenderResponseV1> {
  let current = initial;
  let percent = -1;
  const deadline = Date.now() + 35 * 60_000;
  while (["queued", "preparing", "rendering", "verifying"].includes(current.receipt.state)) {
    if (current.receipt.progress.percent !== percent) {
      percent = current.receipt.progress.percent;
      console.error(`${percent}% · ${current.receipt.progress.message}`);
    }
    if (Date.now() >= deadline) {
      await fetch(`${origin}/api/v1/renders/${current.receipt.renderId}/cancel`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ version: "sequences.render-action.v1" }),
      });
      throw new Error(
        `Render exceeded 35 minutes and was cancelled\nRender receipt: ${renderReceiptPathFor(current.receipt.renderId)}`,
      );
    }
    await Bun.sleep(1_000);
    current = await responseJson(
      await resilientGetFrom(origin, `/api/v1/renders/${current.receipt.renderId}`, readHeaders),
      RenderResponseV1Schema,
    );
  }
  return current;
}

async function resilientGetFrom(
  origin: string,
  path: string,
  headers: HeadersInit,
): Promise<Response> {
  const maxAttempts = 60;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${origin}${path}`, { headers });
      lastStatus = response.status;
      const body = await response.text();
      try {
        JSON.parse(body);
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        // Read-only polling can safely retry an interrupted JSON body.
      }
    } catch {
      // The server can briefly reject reads while browser QA starts.
    }
    if (attempt < maxAttempts) await Bun.sleep(Math.min(attempt * 250, 1_000));
  }
  throw new Error(
    `Website API returned HTTP ${lastStatus} with unreadable JSON after ${maxAttempts} read retries`,
  );
}

function assertAppliedResult(job: JobResponseV1, receiptPath: string): void {
  const { receipt } = job;
  if (!receipt.candidateCommit || !receipt.acceptedCommit) {
    throw new Error(`Applied generation is missing Git commits\nRun receipt: ${receiptPath}`);
  }
  if (receipt.candidateCommit !== receipt.acceptedCommit) {
    throw new Error(
      `Applied generation did not promote its exact candidate\nRun receipt: ${receiptPath}`,
    );
  }
  if (!receipt.qa?.ok || receipt.qa.summary.errorCount !== 0) {
    throw new Error(`Applied generation has no passing QA receipt\nRun receipt: ${receiptPath}`);
  }
  if (receipt.changedFiles.length === 0) {
    throw new Error(
      `Applied generation contains no authored file changes\nRun receipt: ${receiptPath}`,
    );
  }
  for (const required of REQUIRED_AUTHORED_ARTIFACTS) {
    if (!receipt.changedFiles.includes(required)) {
      throw new Error(`Applied generation did not change ${required}\nRun receipt: ${receiptPath}`);
    }
    if (!receipt.final?.artifacts.includes(required)) {
      throw new Error(`Luna did not report ${required} as authored\nRun receipt: ${receiptPath}`);
    }
  }
}

function sandboxFrom(args: readonly string[]): "workspace-write" | "danger-full-access" {
  const flag = args.indexOf("--sandbox");
  const value = flag >= 0 ? args[flag + 1] : undefined;
  if (value !== "workspace-write" && value !== "danger-full-access") {
    throw new Error("Run receipt did not record the effective Codex sandbox");
  }
  return value;
}

export function parseGenerateArguments(args: readonly string[]): GenerateOptions {
  const prompt: string[] = [];
  const imageFiles: string[] = [];
  let renderQuality: GenerateOptions["renderQuality"] = null;
  // Balanced generation is intentionally sequential and can consume its full
  // contract, layout, QA, audit, and render budgets. Keep the client watchdog
  // above that bounded path so it does not cancel an actively improving run.
  let timeoutMinutes = 30;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") {
      continue;
    } else if (argument === "--apply" || argument === "--new-direction") {
      // Kept as harmless compatibility flags; every build is now fresh and auto-applied.
    } else if (argument === "--render") {
      renderQuality = "draft";
    } else if (argument.startsWith("--render=")) {
      const quality = argument.slice("--render=".length);
      if (quality !== "draft" && quality !== "standard" && quality !== "high") {
        throw new Error("--render must be draft, standard, or high");
      }
      renderQuality = quality;
    } else if (argument === "--image") {
      const path = args[index + 1];
      if (!path || path.startsWith("--")) throw new Error("--image requires a file path");
      imageFiles.push(path);
      index += 1;
    } else if (argument.startsWith("--image=")) {
      const path = argument.slice("--image=".length);
      if (!path) throw new Error("--image requires a file path");
      imageFiles.push(path);
    } else if (argument.startsWith("--timeout-minutes=")) {
      timeoutMinutes = Number(argument.slice("--timeout-minutes=".length));
      if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
        throw new Error("--timeout-minutes must be an integer from 1 through 60");
      }
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      prompt.push(argument);
    }
  }

  if (imageFiles.length > 4) throw new Error("At most four --image inputs are supported");
  return { prompt: prompt.join(" ").trim(), imageFiles, renderQuality, timeoutMinutes };
}

export function imageMediaTypeForPath(path: string): "image/png" | "image/jpeg" | "image/webp" {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  throw new Error(`Unsupported image extension for ${path}; use PNG, JPEG, or WebP`);
}

function runReceiptPathFor(jobId: string): string {
  return `data/runs/release-a/${jobId}/receipt.json`;
}

function renderReceiptPathFor(renderId: string): string {
  return `artifacts/renders/release-a/${renderId}/receipt.json`;
}

async function responseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Website API returned HTTP ${response.status} with unreadable JSON`);
  }
  if (!response.ok) {
    const message =
      typeof value === "object" && value !== null && "error" in value
        ? JSON.stringify((value as { error: unknown }).error)
        : text;
    throw new Error(`Website API returned HTTP ${response.status}: ${message}`);
  }
  return schema.parse(value);
}

function usage(): void {
  console.log(
    'Usage: bun run generate -- [--image <file>]… [--render=draft|standard|high] [--timeout-minutes=1..60] "video prompt"',
  );
  console.log(
    "Uploads each image through the website API, then runs the live website's exact fresh-build, QA, automatic-promotion, and optional render routes.",
  );
}

if (import.meta.main) {
  try {
    const options = parseGenerateArguments(process.argv.slice(2));
    if (!options.prompt) {
      usage();
      process.exitCode = 2;
    } else {
      console.log(JSON.stringify(await runGenerate(options), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
