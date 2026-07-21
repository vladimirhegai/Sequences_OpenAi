import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Context } from "hono";
import type { ServerConfig } from "./config";
import { ApiProblem } from "./errors";
import { existingFileWithin } from "./files";

const CLIENT_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export async function serveClientShell(c: Context, config: ServerConfig): Promise<Response> {
  const distRoot = resolve(config.workspaceRoot, "apps", "web", "dist");
  let requested = decodeShellPath(c.req.path);
  if (requested === "" || requested === "/") requested = "index.html";
  else requested = requested.replace(/^\//, "");

  let path: string;
  try {
    path = await existingFileWithin(distRoot, requested);
  } catch (error) {
    if (extname(requested)) throw error;
    try {
      path = await existingFileWithin(distRoot, "index.html");
    } catch {
      return missingBuildResponse();
    }
  }
  const extension = extname(path).toLowerCase();
  const contentType = CLIENT_MIME[extension];
  if (!contentType) throw new ApiProblem(404, "shell_file_not_found", "Client asset not found");
  const metadata = await stat(path);
  if (metadata.size > 25 * 1_024 * 1_024)
    throw new ApiProblem(413, "shell_file_too_large", "Client asset exceeds 25 MiB");

  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Length": String(metadata.size),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (extension === ".html") {
    headers.set(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "font-src 'self' data:",
        `connect-src ${config.expectedOrigin}`,
        `frame-src ${config.expectedOrigin}`,
        "worker-src 'self' blob:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  }
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(await clientBody(path), { status: 200, headers });
}

function decodeShellPath(path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new ApiProblem(400, "invalid_shell_path", "Client path has invalid URL encoding");
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part === "..")
  ) {
    throw new ApiProblem(400, "invalid_shell_path", "Client path is unsafe");
  }
  return decoded;
}

async function clientBody(path: string): Promise<Blob> {
  const bun = (globalThis as typeof globalThis & { Bun?: { file(path: string): Blob } }).Bun;
  if (bun) return bun.file(path);
  const bytes = Uint8Array.from(await readFile(path));
  return new Blob([bytes.buffer]);
}

function missingBuildResponse(): Response {
  const body =
    "<!doctype html><meta charset=utf-8><title>Sequences build required</title><p>Run <code>bun run build</code>, then reopen Sequences.</p>";
  return new Response(body, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
