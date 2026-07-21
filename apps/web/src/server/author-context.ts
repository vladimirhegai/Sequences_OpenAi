import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  ContextReceiptV1Schema,
  type LayoutInspectionV1,
  type RevisionScopeV1,
  type SequenceArtifactV1,
} from "../shared";
import type { AudioDirector } from "./audio-director";
import type { ServerConfig } from "./config";
import { sha256 } from "./files";
import { isWithin, posixPath } from "./files";
import type { SkillCatalogProfile } from "./skill-catalog";
import { selectAuthorCapabilities } from "./capability-selector";
import { selectShowcaseCapsules, SHOWCASE_CAPSULE_GUIDANCE } from "./showcase-capsules";

const MAX_CONTEXT_BYTES = 64 * 1_024;
const CandidateReferencePathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.includes("\\") && !value.startsWith("/") && !value.includes("\0"), {
    message: "Candidate reference paths must be project-relative POSIX paths",
  })
  .refine((value) => !value.split("/").some((part) => !part || part === "." || part === ".."), {
    message: "Candidate reference paths cannot contain empty or traversal segments",
  });

const AuthorContextV1Schema = z
  .object({
    version: z.literal("sequences.author-context.v1"),
    acceptedCommit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    skills: z.array(
      z.object({ id: z.string().min(1).max(120), purpose: z.string().min(1).max(300) }).strict(),
    ),
    capabilities: z.array(
      z
        .object({
          id: z.string().min(1).max(120),
          purpose: z.string().min(1).max(300),
          skill: z.enum(["hyperframes-animation", "hyperframes-creative"]),
          reference: z.string().min(1).max(300),
          constraints: z.array(z.string().min(1).max(300)).max(5),
          candidateReferences: z.array(CandidateReferencePathSchema).max(3).optional(),
        })
        .strict(),
    ),
    showcaseCapsules: z
      .object({
        instruction: z.literal(SHOWCASE_CAPSULE_GUIDANCE),
        selected: z
          .array(
            z
              .object({
                id: z.enum([
                  "slack-ad",
                  "chatgpt-ad",
                  "chatgpt-native-story",
                  "sequences-recommendation-ad",
                  "sequences-abstract-ad",
                ]),
                reference: CandidateReferencePathSchema,
                contactSheet: CandidateReferencePathSchema,
                sourceFiles: z.array(CandidateReferencePathSchema).min(1).max(3),
                tags: z.array(z.string().min(1).max(80)).min(1).max(8),
                useWhen: z.string().min(1).max(500),
                lessons: z.array(z.string().min(1).max(400)).min(1).max(4),
                mistakes: z.array(z.string().min(1).max(400)).min(1).max(4),
              })
              .strict(),
          )
          .min(1)
          .max(2),
      })
      .strict(),
    sequence: z
      .object({
        format: z.unknown(),
        concept: z.unknown(),
        beats: z.array(z.unknown()).max(50),
        transitions: z.array(z.unknown()).max(49),
        overlapIntents: z.array(z.unknown()).max(50),
        audio: z.unknown().nullable(),
        revisionScope: z.unknown().nullable(),
      })
      .strict()
      .nullable(),
    audioCatalog: z.unknown().nullable(),
    qaFindings: z.array(z.unknown()).max(30),
    layoutInspection: z.unknown().nullable(),
  })
  .strict();

export type AuthorContextV1 = z.infer<typeof AuthorContextV1Schema>;
export type ContextReceiptV1 = z.infer<typeof ContextReceiptV1Schema>;

export class AuthorContextGateway {
  private readonly cacheRoot: string;

  constructor(
    config: ServerConfig,
    private readonly audio?: AudioDirector,
  ) {
    this.cacheRoot = join(config.runsRoot, "_context-cache");
  }

  async prepare(options: {
    runRoot: string;
    acceptedCommit: string;
    skills: SkillCatalogProfile;
    prompt: string;
    sequence: SequenceArtifactV1 | null;
    revisionScope: RevisionScopeV1 | null;
    qaFindings?: readonly unknown[];
    layoutInspection?: LayoutInspectionV1 | null;
    artifactDirectory?: string;
  }): Promise<{ context: AuthorContextV1; receipt: ContextReceiptV1 }> {
    const calls: ContextReceiptV1["calls"] = [
      "list_skills",
      "select_capabilities",
      "select_showcase_capsules",
    ];
    if (options.sequence) calls.push("inspect_sequence");
    if ((options.qaFindings?.length ?? 0) > 0) calls.push("read_qa_findings");
    if (options.layoutInspection) calls.push("inspect_layout");
    // The context must fit its budget by construction. A rich authored
    // sequence plus a large finding set once overflowed the cap during
    // repair-context preparation and killed an otherwise repairable run;
    // trimming follows a fixed precedence so the result stays deterministic:
    // drop the inspection packet, then compact findings, then compact the
    // sequence to its contract fields.
    const trims: Array<{
      inspection: boolean;
      findingLimit: number;
      compactFindings: boolean;
      compactSequence: boolean;
      audioCatalog: boolean;
    }> = [
      {
        inspection: true,
        findingLimit: 30,
        compactFindings: false,
        compactSequence: false,
        audioCatalog: true,
      },
      {
        inspection: false,
        findingLimit: 30,
        compactFindings: false,
        compactSequence: false,
        audioCatalog: true,
      },
      {
        inspection: false,
        findingLimit: 12,
        compactFindings: true,
        compactSequence: false,
        audioCatalog: true,
      },
      {
        inspection: false,
        findingLimit: 12,
        compactFindings: true,
        compactSequence: true,
        audioCatalog: false,
      },
      {
        inspection: false,
        findingLimit: 6,
        compactFindings: true,
        compactSequence: true,
        audioCatalog: false,
      },
    ];
    const audioCatalog = this.audio ? await this.audio.authorCatalog() : null;
    const showcaseCapsules = selectShowcaseCapsules(options.prompt, options.sequence);
    let context: AuthorContextV1 | null = null;
    let serialized = "";
    let bytes = 0;
    for (const trim of trims) {
      const candidate = AuthorContextV1Schema.parse({
        version: "sequences.author-context.v1",
        acceptedCommit: options.acceptedCommit,
        skills: options.skills.skills,
        capabilities: selectAuthorCapabilities(options.prompt, options.sequence),
        showcaseCapsules: {
          instruction: SHOWCASE_CAPSULE_GUIDANCE,
          selected: showcaseCapsules,
        },
        sequence: options.sequence
          ? {
              format: options.sequence.format ?? null,
              concept: trim.compactSequence
                ? compactConcept(options.sequence.concept)
                : options.sequence.concept,
              beats: scopedBeats(options.sequence, options.revisionScope).map((beat) =>
                trim.compactSequence ? compactBeat(beat) : beat,
              ),
              transitions: options.sequence.transitions ?? [],
              overlapIntents: options.sequence.overlapIntents,
              audio: options.sequence.audio ?? null,
              revisionScope: options.revisionScope,
            }
          : null,
        audioCatalog: trim.audioCatalog ? audioCatalog : null,
        qaFindings: [...(options.qaFindings ?? [])]
          .slice(0, trim.findingLimit)
          .map((finding) => (trim.compactFindings ? compactFinding(finding) : finding)),
        layoutInspection: trim.inspection ? (options.layoutInspection ?? null) : null,
      });
      const candidateSerialized = `${JSON.stringify(candidate, null, 2)}\n`;
      const candidateBytes = Buffer.byteLength(candidateSerialized, "utf8");
      if (candidateBytes <= MAX_CONTEXT_BYTES) {
        context = candidate;
        serialized = candidateSerialized;
        bytes = candidateBytes;
        break;
      }
    }
    if (!context) {
      throw new Error(`Scoped author context exceeds ${MAX_CONTEXT_BYTES} bytes after trimming`);
    }
    const cacheKey = sha256(serialized);
    const cachePath = join(this.cacheRoot, `${cacheKey}.json`);
    let cacheHit = true;
    try {
      const cached = await readFile(cachePath, "utf8");
      if (cached !== serialized) throw new Error("Context cache hash collision detected");
    } catch (error) {
      if (!isMissing(error)) throw error;
      cacheHit = false;
      await mkdir(this.cacheRoot, { recursive: true });
      await writeFile(cachePath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    const artifactRoot = contextArtifactRoot(options.runRoot, options.artifactDirectory);
    await mkdir(artifactRoot, { recursive: true });
    const artifact = posixPath(relative(options.runRoot, join(artifactRoot, "context.json")));
    await writeFile(join(artifactRoot, "context.json"), serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    const receipt = ContextReceiptV1Schema.parse({
      version: "sequences.context-receipt.v1",
      cacheKey,
      cacheHit,
      bytes,
      calls,
      artifact,
      showcaseCapsules: showcaseCapsules.map(({ id }) => id),
    });
    await writeFile(
      join(artifactRoot, "context-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return { context, receipt };
  }
}

function contextArtifactRoot(runRoot: string, artifactDirectory: string | undefined): string {
  if (!artifactDirectory) return runRoot;
  if (
    !/^turns\/(?:layout-repair-[123]|qa-repair-[12]|workflow-(?:visual-audit|audit-polish))$/.test(
      artifactDirectory,
    )
  ) {
    throw new Error("Author context directory is outside the bounded repair ledger");
  }
  const root = resolve(runRoot);
  const target = resolve(root, artifactDirectory);
  if (!isWithin(root, target)) throw new Error("Author context escaped the run ledger");
  return target;
}

function compactFinding(finding: unknown): Record<string, unknown> {
  const record =
    typeof finding === "object" && finding !== null ? (finding as Record<string, unknown>) : {};
  const compact: Record<string, unknown> = {};
  for (const key of [
    "command",
    "category",
    "code",
    "severity",
    "sourceFile",
    "selector",
    "times",
  ]) {
    if (record[key] !== undefined) compact[key] = record[key];
  }
  if (typeof record.message === "string") compact.message = record.message.slice(0, 300);
  if (typeof record.fixHint === "string") compact.fixHint = record.fixHint.slice(0, 200);
  return compact;
}

function compactConcept(concept: SequenceArtifactV1["concept"]): Record<string, unknown> {
  return {
    summary: concept.summary.slice(0, 500),
    hierarchy: concept.hierarchy.slice(0, 10),
    motionGrammar: concept.motionGrammar.slice(0, 10),
    rejectedChoices: [],
  };
}

function compactBeat(beat: SequenceArtifactV1["beats"][number]): Record<string, unknown> {
  return {
    id: beat.id,
    role: beat.role,
    start: beat.start,
    duration: beat.duration,
    purpose: beat.purpose.slice(0, 200),
    claims: beat.claims.map((claim) => ({
      id: claim.id,
      text: claim.text.slice(0, 120),
      sourceIds: claim.sourceIds,
    })),
    entities: beat.entities.map((entity) => ({
      id: entity.id,
      role: entity.role.slice(0, 120),
      parts: entity.parts,
    })),
    sourceIds: beat.sourceIds,
    musicAnchors: beat.musicAnchors,
    proofTimes: beat.proofTimes,
    implementationFiles: beat.implementationFiles,
    camera: beat.camera ?? null,
  };
}

function scopedBeats(sequence: SequenceArtifactV1, scope: RevisionScopeV1 | null) {
  if (!scope) return sequence.beats;
  const visible = new Set([
    ...scope.targetBeatIds,
    ...scope.unchangedProofs.map((proof) => proof.beatId),
  ]);
  return sequence.beats.filter((beat) => visible.has(beat.id));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
