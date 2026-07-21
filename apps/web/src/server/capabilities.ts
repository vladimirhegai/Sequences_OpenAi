import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CapabilitiesResponseV1 } from "../shared";
import type { ServerConfig } from "./config";
import { errorMessage } from "./errors";
import { SkillBundle } from "./skills";
import { HYPERFRAMES_SKILLS } from "./skill-catalog";

const RegistryManifestSchema = z
  .object({
    $schema: z.literal("https://hyperframes.heygen.com/schema/registry.json"),
    name: z.string().min(1),
    homepage: z.string().url(),
    items: z.array(
      z
        .object({
          name: z.string().min(1).max(160),
          type: z.string().min(1).max(120),
        })
        .strict(),
    ),
  })
  .strict();

export class CapabilityCatalog {
  constructor(
    private readonly config: ServerConfig,
    private readonly skillBundle: SkillBundle,
  ) {}

  async discover(): Promise<CapabilitiesResponseV1> {
    let manifest: Awaited<ReturnType<SkillBundle["verifiedManifest"]>> | null = null;
    let registry: z.infer<typeof RegistryManifestSchema> | null = null;
    const failures: string[] = [];
    try {
      manifest = await this.skillBundle.verifiedManifest();
    } catch (error) {
      failures.push(`skills: ${errorMessage(error)}`);
    }
    if (manifest?.manifest.skills["hyperframes-registry"]) {
      try {
        const raw = await readFile(this.config.registryManifestPath, "utf8");
        registry = RegistryManifestSchema.parse(JSON.parse(raw) as unknown);
      } catch (error) {
        failures.push(`registry: ${errorMessage(error)}`);
      }
    }
    return {
      version: "sequences.capabilities.v1",
      hyperframesVersion: "0.7.56",
      available: failures.length === 0,
      manifestDigest: manifest?.digest ?? null,
      manifestSource: manifest?.manifest.source ?? null,
      skillProfileVersion: manifest?.manifest.version ?? null,
      skillProfileId: manifest?.manifest.profileId ?? null,
      defaultWorkflow: manifest?.manifest.defaultWorkflow ?? null,
      skills: manifest
        ? Object.entries(manifest.manifest.skills)
            .map(([id, value]) => ({
              id,
              purpose:
                HYPERFRAMES_SKILLS.find((skill) => skill.id === id)?.purpose ??
                "Project-local HyperFrames skill.",
              hash: value.hash,
              files: value.files,
            }))
            .sort((a, b) => a.id.localeCompare(b.id))
        : [],
      registry: registry
        ? registry.items
            .map((item) => ({ id: item.name, type: item.type }))
            .sort((a, b) => a.id.localeCompare(b.id))
        : [],
      qaCommands: ["lint", "check", "keyframes", "snapshot", "render"],
      unavailableReason: failures.length > 0 ? failures.join("; ").slice(0, 1_000) : null,
    };
  }
}
