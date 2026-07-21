import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProofComparisonV1Schema, type RevisionScopeV1 } from "../shared";
import type { ServerConfig } from "./config";
import { isWithin, sha256 } from "./files";
import { isolatedToolEnvironment, runProcess } from "./process-runner";

export class ProofComparator {
  constructor(private readonly config: ServerConfig) {}

  async compare(options: {
    jobId: string;
    baseRoot: string;
    candidateRoot: string;
    runRoot: string;
    scope: RevisionScopeV1;
    artifactDirectory?: string;
  }) {
    const artifactDirectory = options.artifactDirectory ?? "proof";
    if (!/^(?:proof|layout-repair\/attempt-[123]\/proof)$/.test(artifactDirectory)) {
      throw new Error("Proof artifact directory is outside the bounded ledger");
    }
    const proofRoot = resolve(options.runRoot, artifactDirectory);
    if (!isWithin(options.runRoot, proofRoot)) {
      throw new Error("Proof artifacts escaped the managed run directory");
    }
    const baseOutput = join(proofRoot, "base");
    const candidateOutput = join(proofRoot, "candidate");
    await mkdir(proofRoot, { recursive: true });
    const times = options.scope.unchangedProofs.map((proof) => proof.time);
    await this.snapshot(options.jobId, options.baseRoot, baseOutput, times);
    await this.snapshot(options.jobId, options.candidateRoot, candidateOutput, times);
    const [baseFiles, candidateFiles] = await Promise.all([
      pngFiles(baseOutput),
      pngFiles(candidateOutput),
    ]);
    if (baseFiles.length !== times.length || candidateFiles.length !== times.length) {
      throw new Error(
        `Proof snapshot count mismatch: expected ${times.length}, base ${baseFiles.length}, candidate ${candidateFiles.length}`,
      );
    }
    const frames = await Promise.all(
      options.scope.unchangedProofs.map(async (proof, index) => {
        const base = await readFile(join(baseOutput, baseFiles[index]!));
        const candidate = await readFile(join(candidateOutput, candidateFiles[index]!));
        const baseSha256 = sha256(base);
        const candidateSha256 = sha256(candidate);
        return {
          beatId: proof.beatId,
          time: proof.time,
          baseSha256,
          candidateSha256,
          identical: baseSha256 === candidateSha256,
        };
      }),
    );
    const receipt = ProofComparisonV1Schema.parse({
      version: "sequences.proof-comparison.v1",
      ok: frames.every((frame) => frame.identical),
      artifact: `${artifactDirectory}/receipt.json`,
      frames,
    });
    await writeFile(
      join(proofRoot, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    return receipt;
  }

  private async snapshot(
    jobId: string,
    projectRoot: string,
    output: string,
    times: readonly number[],
  ): Promise<void> {
    await mkdir(join(output, "tmp"), { recursive: true });
    const cliEntry = join(
      this.config.workspaceRoot,
      "node_modules",
      "hyperframes",
      "dist",
      "cli.js",
    );
    const result = await runProcess({
      executable: this.config.hyperframesCommand,
      args: [
        cliEntry,
        "snapshot",
        projectRoot,
        "--at",
        times.join(","),
        "--output",
        output,
        "--no-end",
      ],
      cwd: projectRoot,
      env: isolatedToolEnvironment(jobId, join(output, "tmp")),
      timeoutMs: 3 * 60 * 1_000,
      maxStdoutBytes: 2 * 1_024 * 1_024,
      maxStderrBytes: 256 * 1_024,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Hyperframes proof snapshot failed: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 4_000)}`,
      );
    }
  }
}

async function pngFiles(directory: string): Promise<string[]> {
  const files = (await readdir(directory))
    .filter((file) => file.toLowerCase().endsWith(".png"))
    .sort();
  for (const file of files) {
    const metadata = await stat(join(directory, file));
    if (!metadata.isFile() || metadata.size < 1_024) {
      throw new Error(`Proof snapshot is missing or implausibly small: ${file}`);
    }
  }
  return files;
}
