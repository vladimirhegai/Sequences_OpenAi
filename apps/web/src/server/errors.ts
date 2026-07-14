import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiErrorV1 } from "../shared";

export class ApiProblem extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
    this.name = "ApiProblem";
  }
}

export function requestId(c: Context): string {
  return c.get("requestId") as string;
}

export function problemResponse(c: Context, error: ApiProblem): Response {
  const body: ApiErrorV1 = {
    version: "sequences.error.v1",
    error: {
      code: error.code,
      message: error.message,
      requestId: requestId(c),
      ...(error.details ? { details: error.details } : {}),
    },
  };
  return c.json(body, error.status);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
