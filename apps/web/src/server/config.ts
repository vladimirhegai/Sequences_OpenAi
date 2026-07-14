import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export interface ServerConfig {
  workspaceRoot: string;
  projectId: "release-a";
  projectTitle: string;
  acceptedRoot: string;
  seedRoot: string;
  candidatesRoot: string;
  runsRoot: string;
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
  hyperframesCommand: string;
  gitCommand: string;
  maxJsonBytes: number;
}

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

export function createServerConfig(overrides: ServerConfigOverrides = {}): ServerConfig {
  const workspaceRoot = resolve(overrides.workspaceRoot ?? process.cwd());
  const port = overrides.port ?? validPort(process.env.SEQUENCES_PORT);
  const expectedOrigin = overrides.expectedOrigin ?? `http://127.0.0.1:${port}`;
  const origin = new URL(expectedOrigin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/") {
    throw new Error("The Sequences server origin must be an http://127.0.0.1 loopback origin");
  }

  const dataRoot = resolve(workspaceRoot, "data");
  const base: ServerConfig = {
    workspaceRoot,
    projectId: "release-a",
    projectTitle: "Release A",
    acceptedRoot: resolve(dataRoot, "projects", "release-a"),
    seedRoot: resolve(workspaceRoot, "fixtures", "release-a"),
    candidatesRoot: resolve(dataRoot, "candidates", "release-a"),
    runsRoot: resolve(dataRoot, "runs", "release-a"),
    skillsRoot: resolve(workspaceRoot, ".agents", "skills"),
    skillsManifestPath: resolve(
      process.env.SEQUENCES_SKILLS_MANIFEST ?? resolve(workspaceRoot, ".agents", "skills-manifest.json"),
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
    codexCommand: "codex",
    hyperframesCommand: "bun",
    gitCommand: "git",
    maxJsonBytes: 64 * 1_024,
  };
  return {
    ...base,
    ...overrides,
    workspaceRoot,
    projectId: "release-a",
    acceptedRoot: resolve(overrides.acceptedRoot ?? base.acceptedRoot),
    seedRoot: resolve(overrides.seedRoot ?? base.seedRoot),
    candidatesRoot: resolve(overrides.candidatesRoot ?? base.candidatesRoot),
    runsRoot: resolve(overrides.runsRoot ?? base.runsRoot),
    skillsRoot: resolve(overrides.skillsRoot ?? base.skillsRoot),
    skillsManifestPath: resolve(overrides.skillsManifestPath ?? base.skillsManifestPath),
    registryManifestPath: resolve(overrides.registryManifestPath ?? base.registryManifestPath),
    expectedOrigin,
    expectedHost: overrides.expectedHost ?? origin.host.toLowerCase(),
    hostname: "127.0.0.1",
    port,
  };
}
