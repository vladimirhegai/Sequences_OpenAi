import { z } from "zod";
import { ApiProblem } from "./errors";

export async function parseJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
  maxBytes: number,
): Promise<z.output<T>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiProblem(415, "json_content_type_required", "Content-Type must be application/json");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > maxBytes) {
      throw new ApiProblem(413, "request_body_too_large", `JSON bodies are limited to ${maxBytes} bytes`);
    }
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel("body limit exceeded");
        throw new ApiProblem(413, "request_body_too_large", `JSON bodies are limited to ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ApiProblem(400, "invalid_json", "The request body is not valid UTF-8 JSON");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.slice(0, 20).map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "body";
      return `${at}: ${issue.message}`;
    });
    throw new ApiProblem(422, "invalid_request", "The request body does not match its versioned contract", details);
  }
  return result.data;
}
