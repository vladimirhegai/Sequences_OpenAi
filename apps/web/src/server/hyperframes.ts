import { cp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { QaReceiptV1Schema, type QaReceiptV1 } from "../shared";
import type { ServerConfig } from "./config";
import { errorMessage } from "./errors";
import { isWithin } from "./files";
import { isolatedToolEnvironment, startProcess, type ProcessResult, type RunningProcess } from "./process-runner";

const LintEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  })
  .passthrough();

const CheckEnvelopeSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();

export class HyperframesVerifier {
  private readonly active = new Map<string, RunningProcess>();

  constructor(private readonly config: ServerConfig) {}

  async verify(jobId: string, candidateRoot: string, runRoot: string): Promise<QaReceiptV1> {
    const qaRoot = resolve(runRoot, "qa-workspace");
    if (!isWithin(runRoot, qaRoot) || relative(runRoot, qaRoot) !== "qa-workspace") {
      throw new Error("QA workspace escaped its managed run directory");
    }
    await cp(candidateRoot, qaRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (source) => ![".git", ".agents", ".env"].includes(source.split(/[\\/]/).at(-1) ?? ""),
    });
    const env = isolatedToolEnvironment(jobId, join(runRoot, "tmp"));
    const cliEntry = join(this.config.workspaceRoot, "node_modules", "hyperframes", "dist", "cli.js");
    const version = await this.command(jobId, [cliEntry, "--version"], qaRoot, env, 10_000);
    if (version.exitCode !== 0 || version.stdout.trim() !== "0.7.56") {
      throw new Error(`Expected Hyperframes 0.7.56; received ${version.stdout.trim() || version.stderr.trim() || "no version"}`);
    }

    const commands: QaReceiptV1["commands"] = [];
    const lint = await this.command(jobId, [cliEntry, "lint", qaRoot, "--json"], qaRoot, env, 2 * 60 * 1_000);
    await writeFile(join(runRoot, "lint.json"), lint.stdout, "utf8");
    await writeFile(join(runRoot, "lint.stderr.log"), lint.stderr.slice(0, 256 * 1_024), "utf8");
    const lintParsed = parseEnvelope(lint.stdout, LintEnvelopeSchema, "lint");
    const lintOk = lint.exitCode === 0 && lintParsed.ok && lintParsed.errorCount === 0 && lintParsed.warningCount === 0;
    commands.push({
      command: "lint",
      ok: lintOk,
      exitCode: lint.exitCode ?? -1,
      durationMs: lint.durationMs,
      errorCount: lintParsed.errorCount,
      warningCount: lintParsed.warningCount,
      artifact: "lint.json",
      ...(!lintOk ? { error: summarizeFailure(lint, "Hyperframes lint reported errors or warnings") } : {}),
    });

    if (lintOk) {
      const check = await this.command(
        jobId,
        [cliEntry, "check", qaRoot, "--json", "--strict", "--snapshots", "--at-transitions", "--frame-check"],
        qaRoot,
        env,
        5 * 60 * 1_000,
      );
      await writeFile(join(runRoot, "check.json"), check.stdout, "utf8");
      await writeFile(join(runRoot, "check.stderr.log"), check.stderr.slice(0, 256 * 1_024), "utf8");
      const checkParsed = parseEnvelope(check.stdout, CheckEnvelopeSchema, "check");
      const checkOk = check.exitCode === 0 && checkParsed.ok;
      commands.push({
        command: "check",
        ok: checkOk,
        exitCode: check.exitCode ?? -1,
        durationMs: check.durationMs,
        artifact: "check.json",
        ...(!checkOk ? { error: summarizeFailure(check, "Hyperframes strict check failed") } : {}),
      });
      try {
        if ((await stat(join(qaRoot, "snapshots"))).isDirectory()) {
          await rename(join(qaRoot, "snapshots"), join(runRoot, "snapshots"));
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }

    const receipt = QaReceiptV1Schema.parse({
      version: "sequences.qa-receipt.v1",
      hyperframesVersion: "0.7.56",
      ok: commands.length === 2 && commands.every((command) => command.ok),
      commands,
    });
    await writeFile(join(runRoot, "qa.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await this.removeQaWorkspace(runRoot, qaRoot);
    return receipt;
  }

  private async command(
    jobId: string,
    args: readonly string[],
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<ProcessResult> {
    const processHandle = startProcess({
      executable: this.config.hyperframesCommand,
      args,
      cwd,
      env,
      timeoutMs,
      maxStdoutBytes: 16 * 1_024 * 1_024,
      maxStderrBytes: 256 * 1_024,
    });
    this.active.set(jobId, processHandle);
    try {
      return await processHandle.result;
    } finally {
      this.active.delete(jobId);
    }
  }

  cancel(jobId: string): boolean {
    const running = this.active.get(jobId);
    if (!running) return false;
    running.cancel();
    return true;
  }

  private async removeQaWorkspace(runRoot: string, qaRoot: string): Promise<void> {
    if (!isWithin(runRoot, qaRoot) || resolve(runRoot) === resolve(qaRoot)) {
      throw new Error("Refusing to remove an unmanaged QA workspace");
    }
    await rm(qaRoot, { recursive: true, force: false });
  }
}

function parseEnvelope<T extends z.ZodTypeAny>(stdout: string, schema: T, command: string): z.output<T> {
  try {
    return schema.parse(JSON.parse(stdout) as unknown);
  } catch (error) {
    throw new Error(`Hyperframes ${command} returned an invalid pinned JSON envelope: ${errorMessage(error)}`);
  }
}

function summarizeFailure(result: ProcessResult, fallback: string): string {
  if (result.timedOut) return `${fallback}: command timed out`;
  return (result.stderr.trim() || fallback).slice(0, 4_000);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
