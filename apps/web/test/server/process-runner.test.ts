import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedToolEnvironment, startProcess } from "../../src/server/process-runner";

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);

describe("subprocess lifecycle", () => {
  it("never forwards OpenAI API keys into isolated tool processes", () => {
    const previousCodexKey = process.env.CODEX_API_KEY;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    try {
      process.env.CODEX_API_KEY = "forbidden-codex-key";
      process.env.OPENAI_API_KEY = "forbidden-openai-key";

      const isolated = isolatedToolEnvironment("run_fixture", tmpdir());

      expect(isolated.CODEX_API_KEY).toBeUndefined();
      expect(isolated.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (previousCodexKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = previousCodexKey;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  });

  it("pins HyperFrames media tools to exact executables in an unlabelled PATH directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-media-tools-"));
    const suffix = process.platform === "win32" ? ".exe" : "";
    const ffmpeg = join(root, `ffmpeg${suffix}`);
    const ffprobe = join(root, `ffprobe${suffix}`);
    await Promise.all([writeFile(ffmpeg, "fixture"), writeFile(ffprobe, "fixture")]);
    const previousPath = process.env.PATH;
    const previousLegacyPath = process.env.Path;
    try {
      process.env.PATH = [root, previousPath ?? previousLegacyPath ?? ""].join(delimiter);
      const isolated = isolatedToolEnvironment("run_fixture", join(root, "tmp"));

      expect(isolated.PATH?.split(delimiter)).toContain(root);
      expect(isolated.HYPERFRAMES_FFMPEG_PATH).toBe(ffmpeg);
      expect(isolated.HYPERFRAMES_FFPROBE_PATH).toBe(ffprobe);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLegacyPath === undefined) delete process.env.Path;
      else process.env.Path = previousLegacyPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("turns a deadline into a completed timed-out result", async () => {
    const process = startProcess({
      executable: globalThis.process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: globalThis.process.cwd(),
      env,
      timeoutMs: 150,
    });

    const result = await within(process.result, 8_000);
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.durationMs).toBeLessThan(8_000);
  });

  it("stops the process tree when a caller cancels", async () => {
    const process = startProcess({
      executable: globalThis.process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: globalThis.process.cwd(),
      env,
      timeoutMs: 30_000,
    });

    process.cancel();
    const result = await within(process.result, 8_000);
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("treats caller-confirmed structured completion as a successful exit", async () => {
    const process = startProcess({
      executable: globalThis.process.execPath,
      args: ["-e", 'console.log("final"); setInterval(() => {}, 1000)'],
      cwd: globalThis.process.cwd(),
      env,
      timeoutMs: 30_000,
      onStdoutLine: (line) => {
        if (line === "final") process.finish();
      },
    });

    const result = await within(process.result, 8_000);
    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("postpones confirmed completion when late work arrives without requiring another final", async () => {
    const process = startProcess({
      executable: globalThis.process.execPath,
      args: [
        "-e",
        'console.log("final"); setTimeout(() => console.log("editing"), 80); setInterval(() => {}, 1000)',
      ],
      cwd: globalThis.process.cwd(),
      env,
      timeoutMs: 30_000,
      onStdoutLine: (line) => {
        if (line === "final") process.finish(150);
        if (line === "editing") process.resume(150);
      },
    });

    const result = await within(process.result, 8_000);
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(200);
  });

  it("terminates immediately when streamed output cannot be consumed", async () => {
    const process = startProcess({
      executable: globalThis.process.execPath,
      args: ["-e", 'console.log("not-json"); setInterval(() => {}, 1000)'],
      cwd: globalThis.process.cwd(),
      env,
      timeoutMs: 30_000,
      onStdoutLine: () => {
        throw new Error("invalid streamed event");
      },
    });

    await expect(within(process.result, 8_000)).rejects.toThrow("invalid streamed event");
  });
});

async function within<T>(value: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("process result did not settle")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
