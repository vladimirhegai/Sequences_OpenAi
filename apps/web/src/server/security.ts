import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { ServerConfig } from "./config";
import { ApiProblem } from "./errors";

const SESSION_COOKIE = "sequences_session";

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    if (pair.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(pair.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export class LocalSecurity {
  constructor(private readonly config: ServerConfig) {}

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      const host = c.req.header("host")?.toLowerCase();
      if (host !== this.config.expectedHost) {
        throw new ApiProblem(403, "invalid_host", "This service accepts only its exact loopback Host");
      }

      const origin = c.req.header("origin");
      const signedStatic = this.isSignedStaticRequest(c.req.path, c.req.method);
      if (origin && origin !== this.config.expectedOrigin && !(signedStatic && origin === "null")) {
        throw new ApiProblem(403, "invalid_origin", "Cross-origin requests are not allowed");
      }

      const path = c.req.path;
      const isShellRead = !path.startsWith("/api/") && ["GET", "HEAD"].includes(c.req.method);
      const isPublic = path === "/api/v1/health" || path === "/api/v1/session" || signedStatic || isShellRead;
      if (!isPublic) {
        const session = cookieValue(c.req.header("cookie") ?? null, SESSION_COOKIE);
        if (!sameSecret(session, this.config.sessionToken) || Date.now() >= this.config.sessionExpiresAt.getTime()) {
          throw new ApiProblem(401, "session_required", "Create a local browser session before using this API");
        }
      }

      const mutating = new Set(["POST", "PUT", "PATCH", "DELETE"]).has(c.req.method);
      if (mutating) {
        if (origin !== this.config.expectedOrigin) {
          throw new ApiProblem(403, "origin_required", "State-changing requests require the exact local Origin");
        }
        if (path !== "/api/v1/session") {
          const csrf = c.req.header("x-sequences-csrf");
          if (!sameSecret(csrf, this.config.csrfToken)) {
            throw new ApiProblem(403, "invalid_csrf", "The CSRF token is missing or invalid");
          }
        }
      }

      await next();
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "no-referrer");
      c.header("Cross-Origin-Resource-Policy", signedStatic ? "cross-origin" : "same-origin");
      c.header("Cache-Control", "no-store");
    };
  }

  acceptsBootToken(token: string): boolean {
    return sameSecret(token, this.config.bootToken);
  }

  acceptsStaticToken(token: string): boolean {
    return sameSecret(token, this.config.staticAccessToken);
  }

  sessionCookie(): string {
    const maxAge = Math.max(0, Math.floor((this.config.sessionExpiresAt.getTime() - Date.now()) / 1_000));
    return `${SESSION_COOKIE}=${encodeURIComponent(this.config.sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  }

  csrfToken(): string {
    return this.config.csrfToken;
  }

  private isSignedStaticRequest(path: string, method: string): boolean {
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) return false;
    const match = /^\/api\/v1\/projects\/release-a\/files\/([^/]+)\/(?:accepted|sample|candidate\/run_[0-9a-f]{32})(?:\/|$)/.exec(path);
    return match ? this.acceptsStaticToken(match[1] ?? "") : false;
  }
}
