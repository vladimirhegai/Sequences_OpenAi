import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSequencesRuntime } from "./app";

export const SERVER_IDLE_TIMEOUT_SECONDS = 30;
export const SERVER_DESCRIPTOR_VERSION = "sequences.local-server.v1" as const;

export async function startSequencesServer() {
  const runtime = await createSequencesRuntime();
  const bun = (
    globalThis as typeof globalThis & {
      Bun?: {
        serve(options: {
          hostname: string;
          port: number;
          idleTimeout: number;
          fetch: (request: Request) => Response | Promise<Response>;
        }): unknown;
      };
    }
  ).Bun;
  if (!bun) throw new Error("Sequences localhost server must run on Bun");
  const server = bun.serve({
    hostname: runtime.config.hostname,
    port: runtime.config.port,
    // Hono's job event stream emits a heartbeat every 15 seconds. Bun defaults
    // to a 10-second HTTP idle timeout, which closes the stream first and then
    // rejects Hono's late lightweight response. Keep a clear safety margin.
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
    fetch: runtime.app.fetch,
  });
  const bootUrl = `${runtime.config.expectedOrigin}/?boot=${encodeURIComponent(runtime.config.bootToken)}`;
  const descriptorPath = join(runtime.config.workspaceRoot, "data", "local-server.json");
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(
    descriptorPath,
    `${JSON.stringify(
      {
        version: SERVER_DESCRIPTOR_VERSION,
        origin: runtime.config.expectedOrigin,
        bootToken: runtime.config.bootToken,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log(`Sequences is available at ${bootUrl}`);
  const authorRuntime =
    runtime.config.agentWorkflowMode === "balanced"
      ? `balanced (preproduction ${runtime.config.agentRoutes.creative_director.model}/${runtime.config.agentRoutes.creative_director.reasoningEffort}, compositor ${runtime.config.agentRoutes.compositor.model}/${runtime.config.agentRoutes.compositor.reasoningEffort}, audit ${runtime.config.agentRoutes.visual_auditor.model}/${runtime.config.agentRoutes.visual_auditor.reasoningEffort})`
      : `${runtime.config.codexModel}/${runtime.config.codexReasoningEffort}`;
  console.log(`Author runtime: ${authorRuntime} · sandbox ${runtime.config.codexSandboxMode}`);
  return { ...runtime, server, bootUrl };
}

if (import.meta.main) await startSequencesServer();
