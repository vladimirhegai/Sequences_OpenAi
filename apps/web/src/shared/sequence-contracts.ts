import { z } from "zod";

import { OverlapIntentV1Schema } from "./layout-contracts";

const StableIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/)
  .max(120);

/**
 * The author contract teaches null-for-absent ("camera": null, "revision":
 * null), so directors reasonably emit null for optional fields they are not
 * using. Rejecting an explicit null on an optional field is a representation
 * quibble, not a semantic failure — accept it and normalize to undefined.
 */
function nullMeansAbsent<T extends z.ZodType>(schema: T) {
  return schema
    .nullish()
    .transform((value): z.output<T> | undefined => (value === null ? undefined : value))
    .optional();
}
const RelativeArtifactPathSchema = z
  .string()
  .min(1)
  .max(180)
  .refine((value) => !value.includes("\\") && !value.startsWith("/") && !value.includes("\0"), {
    message: "Artifact paths must be project-relative POSIX paths",
  })
  .refine((value) => !value.split("/").some((part) => part === "." || part === ".."), {
    message: "Artifact paths cannot contain traversal segments",
  });

export const SequenceClaimV1Schema = z
  .object({
    id: StableIdSchema,
    text: z.string().trim().min(1).max(1_000),
    sourceIds: z.array(StableIdSchema).max(20).default([]),
  })
  .passthrough();

export const AUDIO_SFX_KINDS = ["typing", "mouse-click", "pop", "woosh", "notification"] as const;

/**
 * Director-owned sound plan, adopted from the Slack Sequences audio custody
 * model: the director chooses one catalog soundtrack and semantic SFX cues;
 * the host owns files, hashes, gain, fades, and FFmpeg muxing. Model-authored
 * paths or filter graphs never cross this boundary.
 */
export const AudioCueV1Schema = z.union([
  z
    .object({
      kind: z.literal("typing"),
      startSec: z.number().finite().nonnegative().max(3_600),
      endSec: z.number().finite().positive().max(3_600),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["mouse-click", "pop", "woosh", "notification"]),
      atSec: z.number().finite().nonnegative().max(3_600),
    })
    .strict(),
]);

export const AudioDirectionV1Schema = z
  .object({
    soundtrackId: StableIdSchema,
    cues: z.array(AudioCueV1Schema).max(20).default([]),
  })
  .strict();

export type AudioDirectionV1 = z.infer<typeof AudioDirectionV1Schema>;
export type AudioCueV1 = z.infer<typeof AudioCueV1Schema>;

export const SequenceEntityV1Schema = z
  .object({
    id: StableIdSchema,
    role: z.string().trim().min(1).max(300),
    parts: z.array(StableIdSchema).max(50).default([]),
  })
  .passthrough();

const CameraPoseV1Schema = z
  .object({
    x: z.number().finite().min(-10_000).max(10_000),
    y: z.number().finite().min(-10_000).max(10_000),
    z: z.number().finite().min(-10_000).max(10_000).default(0),
    scale: z.number().finite().positive().max(20),
    rotationX: z.number().finite().min(-360).max(360).default(0),
    rotationY: z.number().finite().min(-360).max(360).default(0),
    rotationZ: z.number().finite().min(-360).max(360).default(0),
    // GSAP and 2D DOM authors commonly call the Z-axis roll `rotation`.
    // Accept that authoring alias, then store only the canonical rotationZ.
    rotation: nullMeansAbsent(z.number().finite().min(-360).max(360)),
  })
  .strict()
  .transform(({ rotation, ...pose }) => ({
    ...pose,
    rotationZ: rotation ?? pose.rotationZ,
  }));

export const CameraIntentV1Schema = z
  .object({
    owner: z.enum(["dom-world", "three-world"]),
    targetEntityId: StableIdSchema,
    startPose: CameraPoseV1Schema,
    endPose: CameraPoseV1Schema,
    arrival: z.number().finite().nonnegative().max(3_600),
    settle: z.number().finite().nonnegative().max(3_600),
    hold: z.number().finite().nonnegative().max(3_600),
  })
  .strict();

export const SequenceTransitionV1Schema = z
  .object({
    id: StableIdSchema,
    fromBeatId: StableIdSchema,
    toBeatId: StableIdSchema,
    kind: z.enum(["cut", "match-cut", "morph", "pan", "zoom-cut", "dissolve", "wipe"]),
    at: z.number().finite().nonnegative().max(3_600),
    duration: z.number().finite().nonnegative().max(3),
    outgoingEntityId: nullMeansAbsent(StableIdSchema),
    incomingEntityId: nullMeansAbsent(StableIdSchema),
    // Rationale documents intent for evidence; its absence is not film
    // invalidity. A live probe authored a valid film and died solely because
    // one plain cut carried no rationale string.
    rationale: nullMeansAbsent(z.string().trim().min(1).max(500)),
  })
  .strict()
  .superRefine((transition, context) => {
    if (
      ["match-cut", "morph"].includes(transition.kind) &&
      (!transition.outgoingEntityId || !transition.incomingEntityId)
    ) {
      context.addIssue({
        code: "custom",
        message: `${transition.kind} transitions require outgoing and incoming semantic entities`,
        path: [],
      });
    }
    if (!["cut", "match-cut"].includes(transition.kind) && transition.duration === 0) {
      context.addIssue({
        code: "custom",
        message: "Only a cut or match-cut can have zero duration",
        path: ["duration"],
      });
    }
  });

export const SequenceBeatV1Schema = z
  .object({
    id: StableIdSchema,
    role: nullMeansAbsent(StableIdSchema),
    start: nullMeansAbsent(z.number().finite().nonnegative().max(3_600)),
    duration: nullMeansAbsent(z.number().finite().positive().max(300)),
    purpose: z.string().trim().min(1).max(1_000),
    claims: z.array(SequenceClaimV1Schema).max(50).default([]),
    entities: z.array(SequenceEntityV1Schema).max(100).default([]),
    sourceIds: z.array(StableIdSchema).max(100).default([]),
    musicAnchors: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
    proofTimes: z.array(z.number().finite().nonnegative().max(3_600)).max(30).min(1),
    implementationFiles: z.array(RelativeArtifactPathSchema).max(30).min(1),
    camera: nullMeansAbsent(CameraIntentV1Schema),
  })
  .passthrough();

export const RevisionProofV1Schema = z
  .object({
    beatId: StableIdSchema,
    time: z.number().finite().nonnegative().max(3_600),
  })
  .strict();

export const RevisionScopeV1Schema = z
  .object({
    targetBeatIds: z.array(StableIdSchema).min(1).max(8),
    targetEntityIds: z.array(StableIdSchema).max(20).default([]),
    unchangedProofs: z.array(RevisionProofV1Schema).max(30).default([]),
  })
  .strict();

export const SequenceArtifactV1Schema = z
  .object({
    version: z.literal("sequences.sequence.v1"),
    format: z
      .object({
        width: z.number().int().positive().max(8_192),
        height: z.number().int().positive().max(8_192),
        fps: z.number().int().positive().max(120),
        targetDuration: z.number().finite().positive().max(3_600),
      })
      .strict()
      .optional(),
    concept: z
      .object({
        summary: z.string().trim().min(1).max(2_000),
        hierarchy: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
        motionGrammar: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
        rejectedChoices: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
      })
      .passthrough(),
    beats: z.array(SequenceBeatV1Schema).min(1).max(50),
    transitions: nullMeansAbsent(z.array(SequenceTransitionV1Schema).max(49)),
    overlapIntents: z.array(OverlapIntentV1Schema).max(50).default([]),
    audio: nullMeansAbsent(AudioDirectionV1Schema),
    revision: RevisionScopeV1Schema.nullable().default(null),
  })
  .passthrough()
  .superRefine((sequence, context) => {
    uniqueIds(sequence.beats, "beat", context);
    uniqueIds(sequence.transitions ?? [], "transition", context, ["transitions"]);
    uniqueIds(sequence.overlapIntents, "overlap intent", context, ["overlapIntents"]);
    const semanticEntityOwners = new Map<string, Set<string>>();
    for (const [index, beat] of sequence.beats.entries()) {
      uniqueIds(beat.claims, `claim in beat ${beat.id}`, context, ["beats", index, "claims"]);
      uniqueIds(beat.entities, `entity in beat ${beat.id}`, context, ["beats", index, "entities"]);
      for (const entity of beat.entities) {
        addSemanticOwner(semanticEntityOwners, entity.id, `entity:${entity.id}`);
        for (const partId of entity.parts) {
          addSemanticOwner(semanticEntityOwners, partId, `part:${entity.id}`);
        }
      }
      if ((beat.start === undefined) !== (beat.duration === undefined)) {
        context.addIssue({
          code: "custom",
          message: `Beat ${beat.id} must declare start and duration together`,
          path: ["beats", index],
        });
      }
      if (beat.camera) {
        const ids = new Set(beat.entities.flatMap((entity) => [entity.id, ...entity.parts]));
        if (!ids.has(beat.camera.targetEntityId)) {
          context.addIssue({
            code: "custom",
            message: `Camera target is not owned by beat ${beat.id}: ${beat.camera.targetEntityId}`,
            path: ["beats", index, "camera", "targetEntityId"],
          });
        }
        if (beat.camera.arrival > beat.camera.settle || beat.camera.settle > beat.camera.hold) {
          context.addIssue({
            code: "custom",
            message: `Camera timing must satisfy arrival <= settle <= hold`,
            path: ["beats", index, "camera"],
          });
        }
      }
    }
    const beatIndex = new Map(sequence.beats.map((beat, index) => [beat.id, index]));
    for (const [transitionIndex, transition] of (sequence.transitions ?? []).entries()) {
      const fromIndex = beatIndex.get(transition.fromBeatId);
      const toIndex = beatIndex.get(transition.toBeatId);
      if (fromIndex === undefined || toIndex === undefined || toIndex !== fromIndex + 1) {
        context.addIssue({
          code: "custom",
          message: `Transition ${transition.id} must connect adjacent beats in story order`,
          path: ["transitions", transitionIndex],
        });
        continue;
      }
      const fromBeat = sequence.beats[fromIndex]!;
      const toBeat = sequence.beats[toIndex]!;
      validateTransitionEntity(
        transition.outgoingEntityId,
        fromBeat,
        "outgoingEntityId",
        transitionIndex,
        context,
      );
      validateTransitionEntity(
        transition.incomingEntityId,
        toBeat,
        "incomingEntityId",
        transitionIndex,
        context,
      );
    }
    for (const [intentIndex, intent] of sequence.overlapIntents.entries()) {
      for (const [entityIndex, entityId] of intent.entities.entries()) {
        const matchCount = semanticEntityOwners.get(entityId)?.size ?? 0;
        if (matchCount === 0) {
          context.addIssue({
            code: "custom",
            message: `Unknown overlap entity or part id: ${entityId}`,
            path: ["overlapIntents", intentIndex, "entities", entityIndex],
          });
        } else if (matchCount > 1) {
          context.addIssue({
            code: "custom",
            message: `Ambiguous overlap entity or part id: ${entityId}`,
            path: ["overlapIntents", intentIndex, "entities", entityIndex],
          });
        }
      }
    }
  });

export type SequenceArtifactV1 = z.infer<typeof SequenceArtifactV1Schema>;
export type RevisionScopeV1 = z.infer<typeof RevisionScopeV1Schema>;

function uniqueIds(
  values: readonly { id: string }[],
  label: string,
  context: z.RefinementCtx,
  path: PropertyKey[] = ["beats"],
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate ${label} id: ${value.id}`,
        path: [...path, index, "id"],
      });
    }
    seen.add(value.id);
  }
}

function addSemanticOwner(ownersById: Map<string, Set<string>>, id: string, owner: string): void {
  const owners = ownersById.get(id) ?? new Set<string>();
  owners.add(owner);
  ownersById.set(id, owners);
}

function validateTransitionEntity(
  entityId: string | undefined,
  beat: z.infer<typeof SequenceBeatV1Schema>,
  field: "outgoingEntityId" | "incomingEntityId",
  transitionIndex: number,
  context: z.RefinementCtx,
): void {
  if (!entityId) return;
  const ids = new Set(beat.entities.flatMap((entity) => [entity.id, ...entity.parts]));
  if (!ids.has(entityId)) {
    context.addIssue({
      code: "custom",
      message: `Transition ${field} is not owned by beat ${beat.id}: ${entityId}`,
      path: ["transitions", transitionIndex, field],
    });
  }
}
