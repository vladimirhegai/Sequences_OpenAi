import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  createServerConfig,
  resolveAgentRoute,
  resolveAgentWorkflowMode,
  resolveCodexSandboxMode,
  type AgentRoutes,
} from "../../src/server/config";

describe("Codex authoring sandbox routing", () => {
  it("uses Windows compatibility mode when no override is configured", () => {
    expect(resolveCodexSandboxMode(undefined, "win32")).toBe("danger-full-access");
  });

  it("keeps the restricted default on non-Windows platforms", () => {
    expect(resolveCodexSandboxMode(undefined, "linux")).toBe("workspace-write");
    expect(resolveCodexSandboxMode(undefined, "darwin")).toBe("workspace-write");
  });

  it("cannot be regressed to the known read-only mode by a Windows override", () => {
    expect(resolveCodexSandboxMode("workspace-write", "win32")).toBe("danger-full-access");
    expect(resolveCodexSandboxMode("danger-full-access", "win32")).toBe("danger-full-access");
  });

  it("preserves explicit valid overrides on platforms with a writable restricted sandbox", () => {
    expect(resolveCodexSandboxMode("workspace-write", "linux")).toBe("workspace-write");
    expect(resolveCodexSandboxMode("danger-full-access", "linux")).toBe("danger-full-access");
  });

  it("rejects an invalid override instead of silently weakening or narrowing it", () => {
    expect(() => resolveCodexSandboxMode("read-only", "win32")).toThrow(
      "SEQUENCES_CODEX_SANDBOX must be either workspace-write or danger-full-access",
    );
  });

  it("applies the platform invariant after direct server-config overrides", () => {
    const config = createServerConfig({
      workspaceRoot: process.cwd(),
      codexSandboxMode: "workspace-write",
    });
    expect(config.codexSandboxMode).toBe(
      process.platform === "win32" ? "danger-full-access" : "workspace-write",
    );
  });
});

describe("server runtime command routing", () => {
  it("runs the HyperFrames CLI with Node even when the host runtime is Bun", () => {
    const previous = process.env.SEQUENCES_HYPERFRAMES_COMMAND;
    delete process.env.SEQUENCES_HYPERFRAMES_COMMAND;
    try {
      expect(createServerConfig({ workspaceRoot: process.cwd() }).hyperframesCommand).toBe("node");
    } finally {
      if (previous === undefined) delete process.env.SEQUENCES_HYPERFRAMES_COMMAND;
      else process.env.SEQUENCES_HYPERFRAMES_COMMAND = previous;
    }
  });
});

describe("agent workflow routing", () => {
  it("uses the latency-balanced specialist workflow by default", () => {
    withRoutingEnvironment({}, () => {
      const config = createServerConfig({ workspaceRoot: process.cwd() });

      expect(config.agentWorkflowMode).toBe("balanced");
      expect(config.agentRoutes).toEqual({
        legacy_director: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        creative_director: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        component_architect: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        compositor: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
        visual_auditor: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      });
      for (const role of AGENT_ROLES) {
        expect(resolveAgentRoute(config, role)).toEqual(config.agentRoutes[role]);
      }
    });
  });

  it("uses strict role-specific routes only when the balanced workflow is enabled", () => {
    withRoutingEnvironment(
      {
        SEQUENCES_AGENT_WORKFLOW: "balanced",
        SEQUENCES_CODEX_MODEL: "gpt-5.6-terra",
        SEQUENCES_CODEX_EFFORT: "medium",
        SEQUENCES_CREATIVE_MODEL: "gpt-5.6-luna",
        SEQUENCES_CREATIVE_EFFORT: "xhigh",
        SEQUENCES_COMPONENT_MODEL: "gpt-5.6-terra",
        SEQUENCES_COMPONENT_EFFORT: "low",
        SEQUENCES_COMPOSITOR_MODEL: "gpt-5.6-sol",
        SEQUENCES_COMPOSITOR_EFFORT: "medium",
        SEQUENCES_AUDITOR_MODEL: "gpt-5.6-terra",
        SEQUENCES_AUDITOR_EFFORT: "xhigh",
      },
      () => {
        const config = createServerConfig({ workspaceRoot: process.cwd() });

        expect(config.agentWorkflowMode).toBe("balanced");
        expect(resolveAgentRoute(config, "legacy_director")).toEqual({
          model: "gpt-5.6-terra",
          reasoningEffort: "medium",
        });
        expect(resolveAgentRoute(config, "creative_director")).toEqual({
          model: "gpt-5.6-luna",
          reasoningEffort: "xhigh",
        });
        expect(resolveAgentRoute(config, "component_architect")).toEqual({
          model: "gpt-5.6-terra",
          reasoningEffort: "low",
        });
        expect(resolveAgentRoute(config, "compositor")).toEqual({
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
        });
        expect(resolveAgentRoute(config, "visual_auditor")).toEqual({
          model: "gpt-5.6-terra",
          reasoningEffort: "xhigh",
        });
      },
    );
  });

  it("makes direct legacy model overrides authoritative for the legacy route", () => {
    withRoutingEnvironment({ SEQUENCES_AGENT_WORKFLOW: "legacy" }, () => {
      const config = createServerConfig({
        workspaceRoot: process.cwd(),
        codexModel: "gpt-5.6-terra",
        codexReasoningEffort: "medium",
      });

      expect(config.agentRoutes.legacy_director).toEqual({
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      });
      expect(resolveAgentRoute(config, "visual_auditor")).toEqual(
        config.agentRoutes.legacy_director,
      );
    });
  });

  it("rejects invalid workflow modes and role routes", () => {
    expect(() => resolveAgentWorkflowMode("committee")).toThrow(
      "SEQUENCES_AGENT_WORKFLOW must be either legacy or balanced",
    );
    withRoutingEnvironment({ SEQUENCES_CREATIVE_EFFORT: "turbo" }, () => {
      expect(() => createServerConfig({ workspaceRoot: process.cwd() })).toThrow();
    });
  });

  it("rejects undeclared route keys in direct configuration", () => {
    withRoutingEnvironment({}, () => {
      const defaults = createServerConfig({ workspaceRoot: process.cwd() }).agentRoutes;
      const invalidRoutes = {
        ...defaults,
        committee_chair: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      } as unknown as AgentRoutes;

      expect(() =>
        createServerConfig({ workspaceRoot: process.cwd(), agentRoutes: invalidRoutes }),
      ).toThrow();
    });
  });
});

const ROUTING_ENVIRONMENT_KEYS = [
  "SEQUENCES_AGENT_WORKFLOW",
  "SEQUENCES_CODEX_MODEL",
  "SEQUENCES_CODEX_EFFORT",
  "SEQUENCES_CREATIVE_MODEL",
  "SEQUENCES_CREATIVE_EFFORT",
  "SEQUENCES_COMPONENT_MODEL",
  "SEQUENCES_COMPONENT_EFFORT",
  "SEQUENCES_COMPOSITOR_MODEL",
  "SEQUENCES_COMPOSITOR_EFFORT",
  "SEQUENCES_AUDITOR_MODEL",
  "SEQUENCES_AUDITOR_EFFORT",
] as const;

function withRoutingEnvironment<T>(
  values: Partial<Record<(typeof ROUTING_ENVIRONMENT_KEYS)[number], string>>,
  run: () => T,
): T {
  const previous = new Map(ROUTING_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const));
  try {
    for (const key of ROUTING_ENVIRONMENT_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
