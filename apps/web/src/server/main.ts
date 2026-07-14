import { createSequencesRuntime } from "./app";

export async function startSequencesServer() {
  const runtime = await createSequencesRuntime();
  const bun = (globalThis as typeof globalThis & {
    Bun?: {
      serve(options: {
        hostname: string;
        port: number;
        fetch: (request: Request) => Response | Promise<Response>;
      }): unknown;
    };
  }).Bun;
  if (!bun) throw new Error("Sequences localhost server must run on Bun");
  const server = bun.serve({
    hostname: runtime.config.hostname,
    port: runtime.config.port,
    fetch: runtime.app.fetch,
  });
  const bootUrl = `${runtime.config.expectedOrigin}/?boot=${encodeURIComponent(runtime.config.bootToken)}`;
  console.log(`Sequences is available at ${bootUrl}`);
  return { ...runtime, server, bootUrl };
}

if (import.meta.main) await startSequencesServer();
