import { z } from "zod";

const StableIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/)
  .max(120);
const BoundedCoordinateSchema = z.number().finite().min(-1_000_000).max(1_000_000);
const BoundedDimensionSchema = z.number().finite().nonnegative().max(1_000_000);
const BoundedTimeSchema = z.number().finite().nonnegative().max(3_600);
const RelativeArtifactPathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.includes("\\") && !value.startsWith("/") && !value.includes("\0"), {
    message: "Artifact paths must be project-relative POSIX paths",
  })
  .refine((value) => !value.split("/").some((part) => part === "." || part === ".."), {
    message: "Artifact paths cannot contain traversal segments",
  });

const TimeRangeSchema = z
  .tuple([BoundedTimeSchema, BoundedTimeSchema])
  .superRefine(([start, end], context) => {
    if (end < start) {
      context.addIssue({
        code: "custom",
        message: "Time range end must be greater than or equal to its start",
        path: [1],
      });
    }
  });

export const LayoutRectV1Schema = z
  .object({
    left: BoundedCoordinateSchema,
    top: BoundedCoordinateSchema,
    right: BoundedCoordinateSchema,
    bottom: BoundedCoordinateSchema,
    width: BoundedDimensionSchema,
    height: BoundedDimensionSchema,
  })
  .strict()
  .superRefine((rect, context) => {
    if (rect.right < rect.left) {
      context.addIssue({
        code: "custom",
        message: "Rectangle right edge must not precede its left edge",
        path: ["right"],
      });
    }
    if (rect.bottom < rect.top) {
      context.addIssue({
        code: "custom",
        message: "Rectangle bottom edge must not precede its top edge",
        path: ["bottom"],
      });
    }
  });

export const OverlapIntentV1Schema = z
  .object({
    id: StableIdSchema,
    kind: z.enum(["overlay", "handoff"]),
    entities: z.array(StableIdSchema).min(2).max(12),
    timeRange: TimeRangeSchema,
    zOrder: z.array(StableIdSchema).min(2).max(12),
    mustRemainReadable: z.array(StableIdSchema).max(12),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .superRefine((intent, context) => {
    addDuplicateStringIssues(intent.entities, context, ["entities"]);
    addDuplicateStringIssues(intent.zOrder, context, ["zOrder"]);
    addDuplicateStringIssues(intent.mustRemainReadable, context, ["mustRemainReadable"]);

    const [start, end] = intent.timeRange;
    if (end === start) {
      context.addIssue({
        code: "custom",
        message: "Overlap intent time range must have a positive duration",
        path: ["timeRange", 1],
      });
    } else if (end - start > 3) {
      context.addIssue({
        code: "custom",
        message: "Overlap intent time range cannot exceed 3 seconds",
        path: ["timeRange", 1],
      });
    }

    const entityIds = new Set(intent.entities);
    if (
      intent.zOrder.length !== intent.entities.length ||
      intent.zOrder.some((entityId) => !entityIds.has(entityId)) ||
      new Set(intent.zOrder).size !== entityIds.size
    ) {
      context.addIssue({
        code: "custom",
        message: "zOrder must be an exact permutation of entities",
        path: ["zOrder"],
      });
    }

    for (const [index, entityId] of intent.mustRemainReadable.entries()) {
      if (!entityIds.has(entityId)) {
        context.addIssue({
          code: "custom",
          message: "mustRemainReadable can only reference declared entities",
          path: ["mustRemainReadable", index],
        });
      }
    }

    if (intent.kind === "overlay" && intent.mustRemainReadable.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Overlay intents must identify at least one readable entity",
        path: ["mustRemainReadable"],
      });
    }
  });

const LayoutArtifactRefsV1Schema = z
  .object({
    inspection: RelativeArtifactPathSchema,
    fullFrame: RelativeArtifactPathSchema,
    crop: RelativeArtifactPathSchema,
  })
  .strict();

export const LayoutClusterV1Schema = z
  .object({
    id: StableIdSchema,
    kind: z.enum(["overlap", "occlusion", "handoff", "overflow"]),
    status: z.enum([
      "undeclared",
      "declared_legible",
      "declared_unreadable",
      "suppression_rejected",
    ]),
    sampleTime: BoundedTimeSchema,
    timeRange: TimeRangeSchema,
    findingCount: z.number().int().min(1).max(1_000),
    observationCount: z.number().int().min(1).max(10_000),
    beatIds: z.array(StableIdSchema).min(1).max(20),
    compositionIds: z.array(StableIdSchema).min(1).max(20),
    sourceFiles: z.array(RelativeArtifactPathSchema).min(1).max(30),
    entityIds: z.array(StableIdSchema).min(2).max(100),
    findingKeys: z
      .array(z.string().regex(/^[0-9a-f]{64}$/))
      .min(1)
      .max(100)
      .optional(),
    intentId: StableIdSchema.nullable(),
    summary: z.string().trim().min(1).max(2_000),
    artifacts: LayoutArtifactRefsV1Schema,
  })
  .strict()
  .superRefine((cluster, context) => {
    addDuplicateStringIssues(cluster.beatIds, context, ["beatIds"]);
    addDuplicateStringIssues(cluster.compositionIds, context, ["compositionIds"]);
    addDuplicateStringIssues(cluster.sourceFiles, context, ["sourceFiles"]);
    addDuplicateStringIssues(cluster.entityIds, context, ["entityIds"]);
    if (cluster.findingKeys)
      addDuplicateStringIssues(cluster.findingKeys, context, ["findingKeys"]);

    if (cluster.observationCount < cluster.findingCount) {
      context.addIssue({
        code: "custom",
        message: "observationCount cannot be less than findingCount",
        path: ["observationCount"],
      });
    }
    if (cluster.sampleTime < cluster.timeRange[0] || cluster.sampleTime > cluster.timeRange[1]) {
      context.addIssue({
        code: "custom",
        message: "sampleTime must fall within timeRange",
        path: ["sampleTime"],
      });
    }
  });

const LayoutScopedIdentityV1Schema = z
  .object({
    beatId: StableIdSchema,
    compositionId: StableIdSchema,
    entityId: StableIdSchema.nullable(),
    hfId: z.string().trim().min(1).max(300).nullable(),
    selector: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .superRefine((identity, context) => {
    if (identity.entityId === null && identity.hfId === null) {
      context.addIssue({
        code: "custom",
        message: "A layout entity must provide entityId or hfId",
        path: ["entityId"],
      });
    }
  });

const LayoutGridV1Schema = z
  .object({
    columns: z.number().int().min(1).max(64),
    rows: z.number().int().min(1).max(64),
    columnGap: BoundedDimensionSchema,
    rowGap: BoundedDimensionSchema,
    margin: BoundedDimensionSchema,
  })
  .strict();

const LayoutEntityV1Schema = z
  .object({
    identity: LayoutScopedIdentityV1Schema,
    bbox: LayoutRectV1Schema,
    opacity: z.number().finite().min(0).max(1),
    zIndex: z.union([z.number().int().min(-1_000_000).max(1_000_000), z.literal("auto")]),
    stackingContexts: z.array(z.string().trim().min(1).max(500)).max(30),
    parentContentBox: LayoutRectV1Schema,
    lineBoxes: z.array(LayoutRectV1Schema).max(200),
    readabilityOwner: StableIdSchema.nullable(),
    readable: z.boolean(),
  })
  .strict();

const LayoutIntersectionV1Schema = z
  .object({
    entityIds: z.tuple([StableIdSchema, StableIdSchema]),
    bbox: LayoutRectV1Schema,
    area: z.number().finite().nonnegative().max(1_000_000_000_000),
    percent: z.number().finite().min(0).max(100),
  })
  .strict()
  .superRefine((intersection, context) => {
    if (intersection.entityIds[0] === intersection.entityIds[1]) {
      context.addIssue({
        code: "custom",
        message: "An intersection must reference two distinct entities",
        path: ["entityIds", 1],
      });
    }
  });

const LayoutGuideV1Schema = z
  .object({
    id: StableIdSchema,
    kind: z.enum(["grid", "edge", "center", "baseline", "safe-area"]),
    axis: z.enum(["x", "y"]),
    position: BoundedCoordinateSchema,
    distance: BoundedDimensionSchema,
    entityIds: z.array(StableIdSchema).max(12),
  })
  .strict();

const LayoutAvailableRegionV1Schema = z
  .object({
    id: StableIdSchema,
    bbox: LayoutRectV1Schema,
    area: z.number().finite().nonnegative().max(1_000_000_000_000),
  })
  .strict();

const LayoutSuggestedPositionV1Schema = z
  .object({
    entityId: StableIdSchema,
    bbox: LayoutRectV1Schema,
    guideIds: z.array(StableIdSchema).max(20),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

const LayoutPolicyViolationV1Schema = z
  .object({
    code: StableIdSchema,
    severity: z.enum(["warning", "error"]),
    entityIds: z.array(StableIdSchema).max(20),
    message: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const LayoutInspectionV1Schema = z
  .object({
    clusterId: StableIdSchema,
    sampleTime: BoundedTimeSchema,
    canvas: LayoutRectV1Schema,
    safeArea: LayoutRectV1Schema,
    grid: LayoutGridV1Schema,
    entities: z.array(LayoutEntityV1Schema).min(2).max(100),
    intersections: z.array(LayoutIntersectionV1Schema).min(1).max(500),
    guides: z.array(LayoutGuideV1Schema).max(200),
    availableRegions: z.array(LayoutAvailableRegionV1Schema).max(100),
    suggestedPositions: z.array(LayoutSuggestedPositionV1Schema).max(100),
    policyViolations: z.array(LayoutPolicyViolationV1Schema).max(100),
  })
  .strict();

export type LayoutRectV1 = z.infer<typeof LayoutRectV1Schema>;
export type OverlapIntentV1 = z.infer<typeof OverlapIntentV1Schema>;
export type LayoutClusterV1 = z.infer<typeof LayoutClusterV1Schema>;
export type LayoutInspectionV1 = z.infer<typeof LayoutInspectionV1Schema>;

function addDuplicateStringIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate value: ${value}`,
        path: [...path, index],
      });
    }
    seen.add(value);
  }
}
