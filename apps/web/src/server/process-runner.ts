import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter } from "node:path";
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
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
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
  let outputError: Error | null = null;
  let lineRemainder = "";
  let callbackQueue = Promise.resolve();
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const maxStdout = spec.maxStdoutBytes ?? 16 * 1_024 * 1_024;
  const maxStderr = spec.maxStderrBytes ?? 256 * 1_024;

  const deliverLines = (text: string): void => {
    const parts = (lineRemainder + text).split(/\r?\n/);
    lineRemainder = parts.pop() ?? "";
    for (const line of parts) {
      callbackQueue = callbackQueue.then(() => spec.onStdoutLine?.(line));
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (outputError) return;
    try {
      const text = stdoutDecoder.write(chunk);
      stdout = appendBounded(stdout, text, maxStdout);
      deliverLines(text);
    } catch (error) {
      outputError = error instanceof Error ? error : new Error(String(error));
      terminateTree(child);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (outputError) return;
    try {
      stderr = appendBounded(stderr, stderrDecoder.write(chunk), maxStderr);
    } catch (error) {
      outputError = error instanceof Error ? error : new Error(String(error));
      terminateTree(child);
    }
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    terminateTree(child);
  }, spec.timeoutMs);
  timeout.unref();

  const result = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timeout);
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      try {
        stdout = appendBounded(stdout, stdoutTail, maxStdout);
        stderr = appendBounded(stderr, stderrTail, maxStderr);
        deliverLines(stdoutTail);
        if (lineRemainder) {
          const finalLine = lineRemainder;
          lineRemainder = "";
          callbackQueue = callbackQueue.then(() => spec.onStdoutLine?.(finalLine));
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
        exitCode,
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
    cancel() {
      if (child.exitCode !== null || child.killed) return;
      cancelled = true;
      terminateTree(child);
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
    .filter((entry) => markers.some((marker) => entry.toLowerCase().includes(marker)))
    .join(delimiter);
}

export function isolatedToolEnvironment(runId: string, tempRoot: string): Record<string, string> {
  const source = process.env;
  const env: Record<string, string> = {
    PATH: narrowedPath(),
    TEMP: tempRoot,
    TMP: tempRoot,
    HYPERFRAMES_RUN_ID: runId,
    HYPERFRAMES_SKIP_SKILLS: "1",
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
  return env;
}

export async function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  return startProcess(spec).result;
}
