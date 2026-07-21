import { describe, expect, it } from "vitest";
import { JOB_EVENT_HEARTBEAT_MS } from "../../src/server/app";
import { SERVER_IDLE_TIMEOUT_SECONDS } from "../../src/server/main";

describe("Bun server timeout ownership", () => {
  it("keeps the HTTP connection alive beyond the job-event heartbeat", () => {
    expect(SERVER_IDLE_TIMEOUT_SECONDS * 1_000).toBeGreaterThan(JOB_EVENT_HEARTBEAT_MS);
    expect(SERVER_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });
});
