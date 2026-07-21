import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_FINAL_JSON_SCHEMA,
  COMPONENT_PLAN_AUTHOR_CONTRACT,
  DESIGN_CAPSULE_AUTHOR_CONTRACT,
  REFERENCE_LOCKED_UI_AUTHOR_CONTRACT,
  SEQUENCE_ARTIFACT_AUTHOR_CONTRACT,
  VISUAL_AUDIT_JSON_SCHEMA,
  assertNoCodexApiKeyEnvironment,
  buildCodexArguments,
  codexUsesChatGptSubscription,
  codexTurnArtifactDirectoryAllowed,
  codexFailureMessage,
  codexFinishQuietPeriodMs,
  codexSandboxWriteBlocked,
  codexTimeoutFor,
  friendlyProgress,
  isCompletionFinal,
  isTransientCodexFailure,
  parseCodexTokenUsage,
  shouldFinishCodexProcess,
} from "../../src/server/codex-runner";
import {
  COMPONENT_INTERACTION_KINDS,
  COMPONENT_SLOT_KINDS,
  DESIGN_COMPOSITION_DIALECTS,
  DESIGN_MOTION_VERBS,
  SAAS_COMPONENT_ARCHETYPES,
} from "../../src/shared";

describe("Codex output contract", () => {
  it("rejects API-key authentication before invoking the local Codex CLI", () => {
    expect(codexUsesChatGptSubscription("", "Logged in using ChatGPT\n")).toBe(true);
    expect(codexUsesChatGptSubscription("Logged in using ChatGPT\n", "")).toBe(true);
    expect(codexUsesChatGptSubscription("", "Logged in using an API key\n")).toBe(false);
    expect(() => assertNoCodexApiKeyEnvironment({})).not.toThrow();
    expect(() => assertNoCodexApiKeyEnvironment({ CODEX_API_KEY: "forbidden" })).toThrow(
      /CODEX_API_KEY/,
    );
    expect(() => assertNoCodexApiKeyEnvironment({ OPENAI_API_KEY: "forbidden" })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it("keeps transient retries inside the bounded turn ledger", () => {
    expect(codexTurnArtifactDirectoryAllowed("turns/workflow-creative-direction-retry-1")).toBe(
      true,
    );
    expect(codexTurnArtifactDirectoryAllowed("turns/qa-repair-2-retry-2")).toBe(true);
    expect(codexTurnArtifactDirectoryAllowed("turns/codex-retry-1")).toBe(true);
    expect(codexTurnArtifactDirectoryAllowed("turns/workflow-composition-retry-3")).toBe(false);
    expect(codexTurnArtifactDirectoryAllowed("turns/../workflow-composition-retry-1")).toBe(false);
  });

  it("keeps preproduction contract-repair turns inside the bounded turn ledger", () => {
    expect(
      codexTurnArtifactDirectoryAllowed("turns/workflow-creative-direction-contract-repair-1"),
    ).toBe(true);
    expect(
      codexTurnArtifactDirectoryAllowed(
        "turns/workflow-creative-direction-contract-repair-1-retry-1",
      ),
    ).toBe(true);
    expect(
      codexTurnArtifactDirectoryAllowed("turns/workflow-creative-direction-contract-repair-5"),
    ).toBe(false);
    expect(codexTurnArtifactDirectoryAllowed("turns/contract-repair-1")).toBe(true);
  });

  it("uses a valid typed JSON Schema literal for the final version", () => {
    expect(CODEX_FINAL_JSON_SCHEMA.properties.version).toEqual({
      type: "string",
      const: "sequences.codex-final.v1",
    });
  });

  it("keeps visual-audit frame references inside the server's stable-ID contract", () => {
    const finding = VISUAL_AUDIT_JSON_SCHEMA.properties.findings.items.properties;
    expect(finding.frameIds.minItems).toBe(1);
    expect(finding.frameIds.maxItems).toBe(40);
    expect(finding.frameIds.items).toMatchObject({
      type: "string",
      maxLength: 120,
      pattern: "^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$",
    });
    expect(finding.beatIds.maxItems).toBe(8);
    expect(finding.entityIds.items).toEqual(finding.frameIds.items);
  });

  it("gives Luna an unambiguous stable-ID semantic artifact shape", () => {
    const contract = SEQUENCE_ARTIFACT_AUTHOR_CONTRACT.join("\n");
    expect(contract).toContain('"claims":[{"id":"claim-id","text":"..."');
    expect(contract).toContain('"entities":[{"id":"hook-card","role":"Recurring product object"');
    expect(contract).toContain('"targetDuration":24');
    expect(contract).toContain('"kind":"match-cut"');
    expect(contract).toContain('"revision":null');
    expect(contract).toContain("never use string shorthand");
    expect(contract).toContain(
      "every entities[].parts entry is a lowercase stable kebab-case identifier",
    );
    expect(contract).toContain("outgoingEntityId belongs to fromBeatId");
    expect(contract).toContain(
      '"entities":["workflow-panel","command-palette"],"timeRange":[4.2,5.6]',
    );
    expect(contract).toContain('"mustRemainReadable":["command-palette"]');
    expect(contract).toContain(
      "Never substitute fields such as fromSec, toSec, entityIds, partIds, readabilityOwners, or rationale",
    );
  });

  it("enumerates every finite design and component vocabulary accepted by the schemas", () => {
    const design = DESIGN_CAPSULE_AUTHOR_CONTRACT.join("\n");
    const components = COMPONENT_PLAN_AUTHOR_CONTRACT.join("\n");

    for (const value of [...DESIGN_COMPOSITION_DIALECTS, ...DESIGN_MOTION_VERBS]) {
      expect(design).toContain(value);
    }
    for (const value of [
      ...SAAS_COMPONENT_ARCHETYPES,
      ...COMPONENT_SLOT_KINDS,
      ...COMPONENT_INTERACTION_KINDS,
    ]) {
      expect(components).toContain(value);
    }
    expect(design).toContain("Never invent a synonym for a schema value");
    expect(components).toContain("Never invent a synonym for a schema value");
    expect(components).toContain(
      "Every component part with morphAnchor true must also appear verbatim",
    );
    expect(components).toContain('component part {"id":"workflow-status","morphAnchor":true,...}');
  });

  it("treats supplied UI screenshots as reference-locked source truth", () => {
    const contract = REFERENCE_LOCKED_UI_AUTHOR_CONTRACT.join("\n");

    expect(contract).toContain("reference-locked visual source truth");
    expect(contract).toContain("override the catalog, house style");
    expect(contract).toContain("Do not reinterpret reference UI");
    expect(contract).toContain('data-reference-image="assets/derived/reference.ext"');
    expect(contract).toContain("product states in a causal story");
    expect(contract).toContain("sourceImageBindings");
    expect(contract).toContain("distinct landed proof moment");
    expect(contract).toContain("reference-only specifications");
    expect(contract).toContain('data-reference-mode="recreated"');
    expect(contract).toContain("moving a flat screenshot with camera motion is a hard failure");
    expect(contract).toContain("product UI itself must retain the screenshot's density");
  });

  it("passes the selected sandbox explicitly and ignores ambient execution rules", () => {
    const args = buildCodexArguments({
      candidateRoot: "C:/candidate",
      schemaPath: "C:/run/schema.json",
      imagePaths: ["assets/reference.png"],
      sandboxMode: "danger-full-access",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      threadId: null,
    });

    expect(args).toEqual([
      "--ask-for-approval",
      "never",
      "--sandbox",
      "danger-full-access",
      "-C",
      "C:/candidate",
      "--model",
      "gpt-5.6-luna",
      "-c",
      'model_reasoning_effort="high"',
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--output-schema",
      "C:/run/schema.json",
      "--image",
      "C:/candidate/assets/reference.png",
      "-",
    ]);
  });

  it("emits one honest progress update per command and file change lifecycle", () => {
    const command = { item: { type: "command_execution" } };
    expect(friendlyProgress({ type: "item.started", ...command }, "C:/candidate")).toMatchObject({
      tool: "shell",
    });
    expect(friendlyProgress({ type: "item.completed", ...command }, "C:/candidate")).toBeNull();

    const fileChange = {
      item: { type: "file_change", changes: [{ path: "C:/candidate/index.html" }] },
    };
    expect(friendlyProgress({ type: "item.started", ...fileChange }, "C:/candidate")).toBeNull();
    expect(
      friendlyProgress({ type: "item.completed", ...fileChange }, "C:/candidate"),
    ).toMatchObject({ tool: "filesystem", currentFile: "index.html" });

    const intermediate = structuredMessage([]);
    expect(friendlyProgress(intermediate, "C:/candidate")).toBeNull();
    expect(friendlyProgress(structuredMessage(["sequence.json"]), "C:/candidate")).toEqual({
      message: "Luna produced a structured authoring checkpoint",
      tool: "codex",
    });
  });

  it("resumes the exact persisted director without using ephemeral mode", () => {
    const args = buildCodexArguments({
      candidateRoot: "C:/candidate-next",
      schemaPath: "C:/run/schema.json",
      imagePaths: [],
      sandboxMode: "danger-full-access",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      threadId: "10000000-0000-4000-8000-000000000001",
    });

    expect(args).toContain("resume");
    expect(args).toContain("10000000-0000-4000-8000-000000000001");
    expect(args).not.toContain("--ephemeral");
    expect(args.slice(args.indexOf("exec"), args.indexOf("--json") + 1)).toEqual([
      "exec",
      "resume",
      "10000000-0000-4000-8000-000000000001",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
    ]);
  });

  it("preserves numeric turn usage before token-shaped log fields are redacted", () => {
    expect(
      parseCodexTokenUsage({
        type: "turn.completed",
        usage: {
          input_tokens: 1_200,
          cached_input_tokens: 800,
          output_tokens: 340,
          reasoning_output_tokens: 90,
        },
      }),
    ).toEqual({
      inputTokens: 1_200,
      cachedInputTokens: 800,
      outputTokens: 340,
      reasoningOutputTokens: 90,
    });
    expect(
      parseCodexTokenUsage({
        type: "turn.completed",
        usage: { input_tokens: "[redacted]" },
      }),
    ).toBeNull();
  });

  it("gives balanced specialist turns tighter latency budgets", () => {
    expect(codexTimeoutFor("build", undefined)).toBe(18 * 60 * 1_000);
    expect(codexTimeoutFor("build", undefined, "compositor")).toBe(10 * 60 * 1_000);
    expect(codexTimeoutFor("build", "creative_direction", "creative_director")).toBe(
      10 * 60 * 1_000,
    );
    expect(codexTimeoutFor("build", "visual_audit", "visual_auditor")).toBe(3 * 60 * 1_000);
    expect(codexTimeoutFor("build", "layout_repair")).toBe(6 * 60 * 1_000);
    expect(codexTimeoutFor("build", "qa_repair")).toBe(6 * 60 * 1_000);
    expect(codexTimeoutFor("build", "contract_repair")).toBe(6 * 60 * 1_000);
    expect(codexTimeoutFor("build", "author_recovery")).toBe(10 * 60 * 1_000);
  });

  it("retries only transient upstream availability failures", () => {
    const base = {
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      stderr: "",
      upstreamError: "Selected model is at capacity. Please retry shortly.",
    };
    expect(isTransientCodexFailure(base)).toBe(true);
    expect(
      isTransientCodexFailure({
        ...base,
        upstreamError: "Output did not match the required schema",
      }),
    ).toBe(false);
    expect(isTransientCodexFailure({ ...base, timedOut: true })).toBe(false);
  });

  it("does not hide an exit-zero read-only sandbox rejection as an empty diff", () => {
    const result = {
      final: null,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      cliVersion: "codex-cli 0.144.0",
      sanitizedArguments: [],
      stderr: "patch rejected: writing is blocked by read-only sandbox",
      threadId: "10000000-0000-4000-8000-000000000001",
      resumed: false,
      upstreamError: null,
    };

    expect(codexSandboxWriteBlocked(result)).toBe(true);
    expect(codexFailureMessage(result)).toBe(
      "Codex authoring could not write because the configured sandbox resolved to read-only",
    );
  });

  it("accepts a build completion only when the claimed artifacts exist on disk", async () => {
    const candidateRoot = await mkdtemp(join(tmpdir(), "sequences-codex-completion-"));
    const claim = JSON.parse(
      structuredMessage([
        "sequence.json",
        "frame.md",
        "index.html",
        "index.motion.json",
        "story/design-capsule.json",
        "story/component-plan.json",
      ]).item.text,
    );
    const build: {
      kind: "build";
      operation?: "author" | "contract_repair" | "layout_repair";
      candidateRoot: string;
    } = {
      kind: "build",
      candidateRoot,
    };
    try {
      // A self-reported artifact list with nothing on disk is progress, not
      // completion; treating it as completion armed the quiet kill window
      // while Luna was still silently reasoning.
      expect(await isCompletionFinal(claim, build)).toBe(false);

      await writeFile(join(candidateRoot, "sequence.json"), "{}\n", "utf8");
      expect(await isCompletionFinal(claim, build)).toBe(false);

      await mkdir(join(candidateRoot, "story"), { recursive: true });
      await writeFile(join(candidateRoot, "story", "component-plan.json"), "{}\n", "utf8");
      expect(await isCompletionFinal(claim, build)).toBe(false);

      await writeFile(join(candidateRoot, "frame.md"), "design\n", "utf8");
      await writeFile(join(candidateRoot, "story", "design-capsule.json"), "{}\n", "utf8");
      expect(await isCompletionFinal(claim, build)).toBe(false);

      await writeFile(join(candidateRoot, "index.motion.json"), "{}\n", "utf8");
      expect(await isCompletionFinal(claim, build)).toBe(false);

      await writeFile(join(candidateRoot, "index.html"), "<main>authored</main>\n", "utf8");
      expect(await isCompletionFinal(claim, build)).toBe(true);

      const progressClaim = JSON.parse(
        structuredMessage([
          "sequence.json",
          "frame.md",
          "index.motion.json",
          "story/design-capsule.json",
          "story/component-plan.json",
        ]).item.text,
      );
      expect(await isCompletionFinal(progressClaim, build)).toBe(false);

      const empty = JSON.parse(structuredMessage([]).item.text);
      expect(await isCompletionFinal(empty, build)).toBe(false);
      expect(await isCompletionFinal(claim, { ...build, operation: "layout_repair" })).toBe(true);
      const repairClaim = JSON.parse(structuredMessage(["sequence.json"]).item.text);
      expect(await isCompletionFinal(repairClaim, { ...build, operation: "contract_repair" })).toBe(
        true,
      );
    } finally {
      await rm(candidateRoot, { recursive: true, force: true });
    }
  });

  it("does not terminate Luna for an artifact-bearing progress checkpoint", () => {
    const completion = JSON.parse(structuredMessage(["sequence.json"]).item.text);

    expect(shouldFinishCodexProcess(structuredMessage(["sequence.json"]), completion)).toBe(false);
    expect(codexFinishQuietPeriodMs(structuredMessage(["sequence.json"]), completion)).toBe(60_000);
    expect(codexFinishQuietPeriodMs({ type: "item.started" }, completion)).toBe(60_000);
    expect(shouldFinishCodexProcess({ type: "item.completed" }, completion)).toBe(false);
    expect(shouldFinishCodexProcess({ type: "turn.completed" }, completion)).toBe(true);
    expect(codexFinishQuietPeriodMs({ type: "turn.completed" }, completion)).toBe(10_000);
    expect(codexFinishQuietPeriodMs(structuredMessage([]), null)).toBeNull();
  });
});

function structuredMessage(artifacts: string[]) {
  return {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        version: "sequences.codex-final.v1",
        intent: "Author the launch film",
        artifacts,
        skillsUsed: [],
        limitations: [],
        proofTimes: [],
      }),
    },
  };
}
