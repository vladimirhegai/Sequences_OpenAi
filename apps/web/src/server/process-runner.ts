import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface ProcessSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  onStdoutLine?: (line: string) => void | Promise<void>;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface RunningProcess {
  readonly pid: number | undefined;
  readonly result: Promise<ProcessResult>;
  finish(afterQuietMs?: number): void;
  resume(afterQuietMs?: number): void;
  cancel(): void;
}

function appendBounded(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") > maxBytes) {
    throw new Error(`Subprocess output exceeded its ${maxBytes}-byte safety limit`);
  }
  return combined;
}

function terminateTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // `child.kill()` only terminates the direct process on Windows. Codex and
    // HyperFrames both launch descendants, and an inherited stdout handle from
    // one surviving descendant keeps Node's `close` event from firing forever.
    // Wait for taskkill to finish so timeout/cancel is a deadline, not a hint.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      timeout: 5_000,
    });
    if (child.exitCode === null) child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export function startProcess(spec: ProcessSpec): RunningProcess {
  if (spec.args.some((arg) => typeof arg !== "string")) {
    throw new Error("Every subprocess argument must be an explicit string token");
  }
  const started = Date.now();
  const child = spawn(spec.executable, [...spec.args], {
    cwd: spec.cwd,
    env: { ...spec.env },
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let cancelled = false;
  let finished = false;
  let outputError: Error | null = null;
  let terminationRequested = false;
  let lineRemainder = "";
  let callbackQueue = Promise.resolve();
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let finishAfterQuietMs: number | null = null;
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const maxStdout = spec.maxStdoutBytes ?? 16 * 1_024 * 1_024;
  const maxStderr = spec.maxStderrBytes ?? 256 * 1_024;

  const requestTermination = (): void => {
    if (child.exitCode !== null) return;
    if (!terminationRequested) {
      terminationRequested = true;
      terminateTree(child);
    }
    forceKillTimer ??= setTimeout(() => {
      if (child.exitCode === null) terminateTree(child);
    }, 2_000);
  };

  const failOutput = (error: unknown): void => {
    if (outputError) return;
    outputError = error instanceof Error ? error : new Error(String(error));
    requestTermination();
  };

  const armFinishTimer = (): void => {
    if (finishAfterQuietMs === null || terminationRequested) return;
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = setTimeout(requestTermination, finishAfterQuietMs);
  };

  const deliverLines = (text: string): void => {
    const parts = (lineRemainder + text).split(/\r?\n/);
    lineRemainder = parts.pop() ?? "";
    for (const line of parts) {
      callbackQueue = callbackQueue.then(async () => {
        try {
          await spec.onStdoutLine?.(line);
        } catch (error) {
          failOutput(error);
        }
      });
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (outputError) return;
    try {
      const text = stdoutDecoder.write(chunk);
      stdout = appendBounded(stdout, text, maxStdout);
      deliverLines(text);
    } catch (error) {
      failOutput(error);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (outputError) return;
    try {
      stderr = appendBounded(stderr, stderrDecoder.write(chunk), maxStderr);
    } catch (error) {
      failOutput(error);
    }
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    requestTermination();
  }, spec.timeoutMs);

  const result = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (finishTimer) clearTimeout(finishTimer);
      reject(error);
    });
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (finishTimer) clearTimeout(finishTimer);
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      try {
        stdout = appendBounded(stdout, stdoutTail, maxStdout);
        stderr = appendBounded(stderr, stderrTail, maxStderr);
        deliverLines(stdoutTail);
        if (lineRemainder) {
          const finalLine = lineRemainder;
          lineRemainder = "";
          callbackQueue = callbackQueue.then(async () => {
            try {
              await spec.onStdoutLine?.(finalLine);
            } catch (error) {
              failOutput(error);
            }
          });
        }
        await callbackQueue;
      } catch (error) {
        outputError = error instanceof Error ? error : new Error(String(error));
      }
      if (outputError) {
        reject(outputError);
        return;
      }
      resolve({
        exitCode: finished && !timedOut && !cancelled ? 0 : exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
      });
    });
  });

  if (spec.stdin !== undefined) child.stdin.end(spec.stdin, "utf8");
  else child.stdin.end();

  return {
    pid: child.pid,
    result,
    finish(afterQuietMs = 0) {
      if (child.exitCode !== null) return;
      finished = true;
      finishAfterQuietMs = Math.max(0, afterQuietMs);
      armFinishTimer();
    },
    resume(afterQuietMs) {
      if (terminationRequested || child.exitCode !== null) return;
      if (finishAfterQuietMs !== null && afterQuietMs !== undefined) {
        finished = true;
        finishAfterQuietMs = Math.max(0, afterQuietMs);
        armFinishTimer();
        return;
      }
      finished = false;
      finishAfterQuietMs = null;
      if (finishTimer) clearTimeout(finishTimer);
      finishTimer = null;
    },
    cancel() {
      if (child.exitCode !== null) return;
      cancelled = true;
      requestTermination();
    },
  };
}

function narrowedPath(): string {
  const original = process.env.PATH ?? process.env.Path ?? "";
  const markers = [
    "bun",
    "node",
    "git",
    "ffmpeg",
    "chrome",
    "chromium",
    "codex",
    "openai",
    "powershell",
    "system32",
  ];
  return original
    .split(delimiter)
    .filter(
      (entry) =>
        markers.some((marker) => entry.toLowerCase().includes(marker)) ||
        approvedExecutableIn(entry),
    )
    .join(delimiter);
}

function approvedExecutableIn(directory: string): boolean {
  if (!unquote(directory)) return false;
  const names = ["bun", "node", "git", "ffmpeg", "ffprobe", "codex", "powershell"];
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return names.some((name) =>
    extensions.some((extension) => existsSync(join(unquote(directory), `${name}${extension}`))),
  );
}

function executableOnPath(name: string): string | undefined {
  const original = process.env.PATH ?? process.env.Path ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of original.split(delimiter)) {
    if (!unquote(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(unquote(directory), `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/, "$1");
}

export function isolatedToolEnvironment(runId: string, tempRoot: string): Record<string, string> {
  const source = process.env;
  const env: Record<string, string> = {
    PATH: narrowedPath(),
    TEMP: tempRoot,
    TMP: tempRoot,
    HYPERFRAMES_RUN_ID: runId,
    HYPERFRAMES_SKIP_SKILLS: "1",
    HYPERFRAMES_NO_AUTO_INSTALL: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    CI: "1",
  };
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "CODEX_HOME",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    "HYPERFRAMES_BROWSER_PATH",
    "FFMPEG_PATH",
    "FFPROBE_PATH",
  ]) {
    const value = source[key];
    if (value) env[key] = value;
  }
  for (const [hyperframesKey, configuredKey, binary] of [
    ["HYPERFRAMES_FFMPEG_PATH", "FFMPEG_PATH", "ffmpeg"],
    ["HYPERFRAMES_FFPROBE_PATH", "FFPROBE_PATH", "ffprobe"],
  ] as const) {
    const explicit = source[hyperframesKey] ?? source[configuredKey];
    const resolved = explicit && existsSync(explicit) ? explicit : executableOnPath(binary);
    if (resolved) env[hyperframesKey] = resolved;
  }
  return env;
}

export async function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  return startProcess(spec).result;
}
