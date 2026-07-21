import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import type { Context } from "hono";
import type { ServerConfig } from "./config";
import { ApiProblem } from "./errors";
import { existingFileWithin } from "./files";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export async function serveCompositionPreview(
  c: Context,
  config: ServerConfig,
  root: string,
): Promise<Response> {
  const html = await bundleToSingleHtml(root);
  const size = Buffer.byteLength(html, "utf8");
  if (size > 512 * 1_024 * 1_024) {
    throw new ApiProblem(
      413,
      "project_file_too_large",
      "Bundled project previews larger than 512 MiB are not previewable",
    );
  }

  const headers = projectResponseHeaders(c, config, "text/html; charset=utf-8");
  headers.delete("Accept-Ranges");
  applyProjectContentSecurityPolicy(headers);
  headers.set("Content-Length", String(size));
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(html, { status: 200, headers });
}

export async function serveProjectFile(
  c: Context,
  config: ServerConfig,
  root: string,
  rawPath: string,
): Promise<Response> {
  const requestedPath = normalizeStaticPath(rawPath || "index.html");
  const extension = extname(requestedPath).toLowerCase();
  const contentType = MIME_TYPES[extension];
  if (!contentType)
    throw new ApiProblem(404, "file_not_found", "This project file type is not browser-servable");
  const absolute = await existingFileWithin(root, requestedPath);
  const metadata = await stat(absolute);
  if (metadata.size > 512 * 1_024 * 1_024) {
    throw new ApiProblem(
      413,
      "project_file_too_large",
      "Project files larger than 512 MiB are not previewable",
    );
  }

  const responseHeaders = projectResponseHeaders(c, config, contentType);
  if (extension === ".html" || extension === ".svg") {
    applyProjectContentSecurityPolicy(responseHeaders);
  }

  const range = parseRange(c.req.header("range"), metadata.size);
  if (range) {
    responseHeaders.set("Content-Range", `bytes ${range.start}-${range.end}/${metadata.size}`);
    responseHeaders.set("Content-Length", String(range.end - range.start + 1));
    if (c.req.method === "HEAD")
      return new Response(null, { status: 206, headers: responseHeaders });
    return new Response(await fileBody(absolute, range.start, range.end + 1), {
      status: 206,
      headers: responseHeaders,
    });
  }
  responseHeaders.set("Content-Length", String(metadata.size));
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers: responseHeaders });
  return new Response(await fileBody(absolute), { status: 200, headers: responseHeaders });
}

function projectResponseHeaders(c: Context, config: ServerConfig, contentType: string): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": staticRequestOrigin(c, config),
    Vary: "Origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

function applyProjectContentSecurityPolicy(headers: Headers): void {
  headers.set(
    "Content-Security-Policy",
    [
      // Match the HyperFrames player's iframe sandbox. Preview files use a
      // separate loopback origin, so preserving their origin does not expose
      // the authenticated app document.
      "sandbox allow-scripts allow-same-origin",
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' data:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self'",
      "worker-src blob:",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
  );
}

export function staticPreflight(c: Context, config: ServerConfig): Response {
  const headers = new Headers({
    "Access-Control-Allow-Origin": staticRequestOrigin(c, config),
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
  return new Response(null, { status: 204, headers });
}

function staticRequestOrigin(c: Context, config: ServerConfig): string {
  const origin = c.req.header("origin");
  return origin === config.expectedOrigin || origin === config.previewOrigin ? origin : "null";
}

export async function serveDownload(
  c: Context,
  path: string,
  filename: string,
  contentType: string,
): Promise<Response> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 2 * 1_024 * 1_024 * 1_024) {
    throw new ApiProblem(404, "download_not_found", "Download artifact was not found");
  }
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const range = parseRange(c.req.header("range"), metadata.size);
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${metadata.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    if (c.req.method === "HEAD") return new Response(null, { status: 206, headers });
    return new Response(await fileBody(path, range.start, range.end + 1), { status: 206, headers });
  }
  headers.set("Content-Length", String(metadata.size));
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(await fileBody(path), { status: 200, headers });
}

function normalizeStaticPath(rawPath: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new ApiProblem(400, "invalid_file_path", "Project file path has invalid URL encoding");
  }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.startsWith("/")) {
    throw new ApiProblem(400, "invalid_file_path", "Project file path is not a safe relative path");
  }
  const segments = decoded.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        segment === "sequences" ||
        segment === "story" ||
        segment === "node_modules",
    )
  ) {
    throw new ApiProblem(
      403,
      "project_file_protected",
      "This project path is not part of the browser preview surface",
    );
  }
  return segments.join("/");
}

function parseRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]))
    throw new ApiProblem(416, "invalid_range", "Only one byte range is supported");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw new ApiProblem(416, "invalid_range", "Invalid suffix byte range");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    throw new ApiProblem(
      416,
      "range_not_satisfiable",
      "Requested byte range is outside this project file",
    );
  }
  return { start, end: Math.min(end, size - 1) };
}

async function fileBody(path: string, start?: number, end?: number): Promise<Blob> {
  const bun = (
    globalThis as typeof globalThis & {
      Bun?: { file(path: string): Blob };
    }
  ).Bun;
  if (bun) {
    const file = bun.file(path);
    return start === undefined ? file : file.slice(start, end);
  }
  const bytes = await readFile(path);
  const selected = start === undefined ? bytes : bytes.subarray(start, end);
  const copy = Uint8Array.from(selected);
  return new Blob([copy.buffer]);
}
