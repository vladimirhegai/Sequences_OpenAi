import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  CodexModelIdSchema,
  MODEL_ID,
  REASONING_EFFORT,
  ReasoningEffortSchema,
  type CodexModelId,
  type ReasoningEffort,
} from "../shared";

export const AGENT_ROLES = [
  "legacy_director",
  "creative_director",
  "component_architect",
  "compositor",
  "visual_auditor",
] as const;

export type AgentWorkflowMode = "legacy" | "balanced";
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentRoute {
  readonly model: CodexModelId;
  readonly reasoningEffort: ReasoningEffort;
}

export type AgentRoutes = Readonly<Record<AgentRole, AgentRoute>>;

const AgentRouteSchema = z
  .object({
    model: CodexModelIdSchema,
    reasoningEffort: ReasoningEffortSchema,
  })
  .strict();

const AgentRoutesSchema = z
  .object({
    legacy_director: AgentRouteSchema,
    creative_director: AgentRouteSchema,
    component_architect: AgentRouteSchema,
    compositor: AgentRouteSchema,
    visual_auditor: AgentRouteSchema,
  })
  .strict();

export interface ServerConfig {
  workspaceRoot: string;
  projectId: "release-a";
  projectTitle: string;
  acceptedRoot: string;
  seedRoot: string;
  shellRoot: string;
  candidatesRoot: string;
  runsRoot: string;
  rendersRoot: string;
  renderWorktreesRoot: string;
  imageInputsRoot: string;
  skillsRoot: string;
  skillsManifestPath: string;
  registryManifestPath: string;
  expectedOrigin: string;
  expectedHost: string;
  hostname: "127.0.0.1";
  port: number;
  bootToken: string;
  sessionToken: string;
  csrfToken: string;
  staticAccessToken: string;
  sessionExpiresAt: Date;
  codexCommand: string;
  codexSandboxMode: CodexSandboxMode;
  codexModel: CodexModelId;
  codexReasoningEffort: ReasoningEffort;
  agentWorkflowMode: AgentWorkflowMode;
  agentRoutes: AgentRoutes;
  hyperframesCommand: string;
  gitCommand: string;
  ffmpegCommand: string;
  ffprobeCommand: string;
  maxJsonBytes: number;
}

export type CodexSandboxMode = "workspace-write" | "danger-full-access";

export type ServerConfigOverrides = Partial<ServerConfig> & { workspaceRoot?: string };

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function validPort(value: string | undefined): number {
  const parsed = Number(value ?? "4317");
  if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535) {
    throw new Error("SEQUENCES_PORT must be an integer from 1024 through 65535");
  }
  return parsed;
}

function codexModel(value: string | undefined, fallback: CodexModelId = MODEL_ID): CodexModelId {
  return CodexModelIdSchema.parse(value ?? fallback);
}

function codexReasoningEffort(
  value: string | undefined,
  fallback: ReasoningEffort = REASONING_EFFORT,
): ReasoningEffort {
  return ReasoningEffortSchema.parse(value ?? fallback);
}

export function resolveAgentWorkflowMode(value: string | undefined): AgentWorkflowMode {
  const mode = value ?? "balanced";
  if (mode !== "legacy" && mode !== "balanced") {
    throw new Error("SEQUENCES_AGENT_WORKFLOW must be either legacy or balanced");
  }
  return mode;
}

export function resolveAgentRoute(
  config: Pick<ServerConfig, "agentWorkflowMode" | "agentRoutes">,
  requestedRole: AgentRole,
): AgentRoute {
  const role = config.agentWorkflowMode === "legacy" ? "legacy_director" : requestedRole;
  return config.agentRoutes[role];
}

function configuredAgentRoutes(
  legacyModel: CodexModelId,
  legacyReasoningEffort: ReasoningEffort,
): AgentRoutes {
  return AgentRoutesSchema.parse({
    legacy_director: {
      model: legacyModel,
      reasoningEffort: legacyReasoningEffort,
    },
    creative_director: {
      model: codexModel(process.env.SEQUENCES_CREATIVE_MODEL, "gpt-5.6-sol"),
      reasoningEffort: codexReasoningEffort(process.env.SEQUENCES_CREATIVE_EFFORT, "medium"),
    },
    component_architect: {
      model: codexModel(process.env.SEQUENCES_COMPONENT_MODEL, "gpt-5.6-sol"),
      reasoningEffort: codexReasoningEffort(process.env.SEQUENCES_COMPONENT_EFFORT, "medium"),
    },
    compositor: {
      model: codexModel(process.env.SEQUENCES_COMPOSITOR_MODEL, "gpt-5.6-terra"),
      reasoningEffort: codexReasoningEffort(process.env.SEQUENCES_COMPOSITOR_EFFORT, "medium"),
    },
    visual_auditor: {
      model: codexModel(process.env.SEQUENCES_AUDITOR_MODEL, "gpt-5.6-sol"),
      reasoningEffort: codexReasoningEffort(process.env.SEQUENCES_AUDITOR_EFFORT, "medium"),
    },
  });
}

export function resolveCodexSandboxMode(
  value: string | undefined,
  platform: NodeJS.Platform,
): CodexSandboxMode {
  // Native Windows workspace-write can silently resolve to read-only while the
  // CLI still exits successfully. Sequences authors only in disposable
  // candidate worktrees and accepts an allowlisted Git diff, so Windows always
  // uses the compatibility mode and cannot be overridden back into that state.
  const mode = value ?? (platform === "win32" ? "danger-full-access" : "workspace-write");
  if (mode !== "workspace-write" && mode !== "danger-full-access") {
    throw new Error("SEQUENCES_CODEX_SANDBOX must be either workspace-write or danger-full-access");
  }
  return platform === "win32" ? "danger-full-access" : mode;
}

export function createServerConfig(overrides: ServerConfigOverrides = {}): ServerConfig {
  const workspaceRoot = resolve(overrides.workspaceRoot ?? process.cwd());
  const port = overrides.port ?? validPort(process.env.SEQUENCES_PORT);
  const resolvedCodexSandboxMode = resolveCodexSandboxMode(
    overrides.codexSandboxMode ?? process.env.SEQUENCES_CODEX_SANDBOX,
    process.platform,
  );
  const resolvedCodexModel = codexModel(overrides.codexModel ?? process.env.SEQUENCES_CODEX_MODEL);
  const resolvedCodexReasoningEffort = codexReasoningEffort(
    overrides.codexReasoningEffort ?? process.env.SEQUENCES_CODEX_EFFORT,
  );
  const resolvedAgentWorkflowMode = resolveAgentWorkflowMode(
    overrides.agentWorkflowMode ?? process.env.SEQUENCES_AGENT_WORKFLOW,
  );
  const resolvedAgentRoutes = AgentRoutesSchema.parse(
    overrides.agentRoutes ??
      configuredAgentRoutes(resolvedCodexModel, resolvedCodexReasoningEffort),
  );
  const expectedOrigin = overrides.expectedOrigin ?? `http://127.0.0.1:${port}`;
  const origin = new URL(expectedOrigin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/") {
    throw new Error("The Sequences server origin must be an http://127.0.0.1 loopback origin");
  }

  const dataRoot = resolve(workspaceRoot, "data");
  const base: ServerConfig = {
    workspaceRoot,
    projectId: "release-a",
    projectTitle: "Untitled video",
    acceptedRoot: resolve(dataRoot, "projects", "release-a"),
    seedRoot: resolve(workspaceRoot, "fixtures", "release-a"),
    shellRoot: resolve(workspaceRoot, "fixtures", "saas-shell"),
    candidatesRoot: resolve(dataRoot, "candidates", "release-a"),
    runsRoot: resolve(dataRoot, "runs", "release-a"),
    rendersRoot: resolve(workspaceRoot, "artifacts", "renders", "release-a"),
    renderWorktreesRoot: resolve(dataRoot, "render-worktrees", "release-a"),
    imageInputsRoot: resolve(dataRoot, "image-inputs", "release-a"),
    skillsRoot: resolve(workspaceRoot, ".agents", "skills"),
    skillsManifestPath: resolve(
      process.env.SEQUENCES_SKILLS_MANIFEST ??
        resolve(workspaceRoot, ".agents", "skills-manifest.json"),
    ),
    registryManifestPath: resolve(
      process.env.SEQUENCES_REGISTRY_MANIFEST ??
        resolve(workspaceRoot, ".agents", "registry", "registry.json"),
    ),
    expectedOrigin,
    expectedHost: origin.host.toLowerCase(),
    hostname: "127.0.0.1",
    port,
    bootToken: secret(),
    sessionToken: secret(),
    csrfToken: secret(),
    staticAccessToken: secret(),
    sessionExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1_000),
    codexCommand: process.env.SEQUENCES_CODEX_COMMAND ?? "codex",
    codexSandboxMode: resolvedCodexSandboxMode,
    // Legacy remains available for controlled comparisons. Balanced role
    // routes are the production default; every actual turn records its model.
    codexModel: resolvedCodexModel,
    codexReasoningEffort: resolvedCodexReasoningEffort,
    agentWorkflowMode: resolvedAgentWorkflowMode,
    agentRoutes: resolvedAgentRoutes,
    // Match scripts/hyperframes.ts: the pinned CLI entry is a Node program even
    // though the Sequences host itself runs on Bun.
    hyperframesCommand: process.env.SEQUENCES_HYPERFRAMES_COMMAND ?? "node",
    gitCommand: "git",
    ffmpegCommand: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobeCommand: process.env.FFPROBE_PATH ?? "ffprobe",
    maxJsonBytes: 64 * 1_024,
  };
  return {
    ...base,
    ...overrides,
    workspaceRoot,
    projectId: "release-a",
    acceptedRoot: resolve(overrides.acceptedRoot ?? base.acceptedRoot),
    seedRoot: resolve(overrides.seedRoot ?? base.seedRoot),
    shellRoot: resolve(overrides.shellRoot ?? base.shellRoot),
    candidatesRoot: resolve(overrides.candidatesRoot ?? base.candidatesRoot),
    runsRoot: resolve(overrides.runsRoot ?? base.runsRoot),
    rendersRoot: resolve(overrides.rendersRoot ?? base.rendersRoot),
    renderWorktreesRoot: resolve(overrides.renderWorktreesRoot ?? base.renderWorktreesRoot),
    imageInputsRoot: resolve(overrides.imageInputsRoot ?? base.imageInputsRoot),
    skillsRoot: resolve(overrides.skillsRoot ?? base.skillsRoot),
    skillsManifestPath: resolve(overrides.skillsManifestPath ?? base.skillsManifestPath),
    registryManifestPath: resolve(overrides.registryManifestPath ?? base.registryManifestPath),
    expectedOrigin,
    expectedHost: overrides.expectedHost ?? origin.host.toLowerCase(),
    hostname: "127.0.0.1",
    port,
    // Reassert after spreading overrides so internal callers cannot bypass the
    // same production invariant enforced for environment configuration.
    codexSandboxMode: resolvedCodexSandboxMode,
    codexModel: resolvedCodexModel,
    codexReasoningEffort: resolvedCodexReasoningEffort,
    agentWorkflowMode: resolvedAgentWorkflowMode,
    agentRoutes: resolvedAgentRoutes,
  };
}
