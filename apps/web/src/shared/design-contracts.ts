import { z } from "zod";

const StableIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/)
  .max(120);

const RelativeDesignPathSchema = z
  .string()
  .min(1)
  .max(180)
  .refine((value) => !value.includes("\\") && !value.startsWith("/") && !value.includes("\0"), {
    message: "Design paths must be project-relative POSIX paths",
  })
  .refine((value) => !value.split("/").some((part) => part === "." || part === ".."), {
    message: "Design paths cannot contain traversal segments",
  });

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const CssVariableSchema = z.string().regex(/^--[a-z][a-z0-9-]{1,63}$/);

export const DESIGN_CATALOG_IDS = [
  "signal-light",
  "precision-dark",
  "editorial-warm",
  "impact-poster",
] as const;

export const DesignCatalogIdSchema = z.enum(DESIGN_CATALOG_IDS);
export const DESIGN_COMPOSITION_DIALECTS = [
  "full-bleed-product",
  "split-evidence",
  "editorial-diagram",
  "poster-to-product",
  "product-closeup",
] as const;
export const DESIGN_MOTION_VERBS = [
  "focus-push",
  "state-swap",
  "cursor-cause",
  "panel-slide",
  "type-build",
  "data-resolve",
  "mask-reveal",
  "identity-match",
] as const;
export const DesignCompositionDialectSchema = z.enum(DESIGN_COMPOSITION_DIALECTS);
export const DesignMotionVerbSchema = z.enum(DESIGN_MOTION_VERBS);

const DesignPaletteV1Schema = z
  .object({
    background: HexColorSchema,
    surface: HexColorSchema,
    text: HexColorSchema,
    muted: HexColorSchema,
    accent: HexColorSchema,
    accentText: HexColorSchema,
    border: HexColorSchema,
  })
  .strict();

const MontserratWeightSchema = z.union([
  z.literal(500),
  z.literal(600),
  z.literal(700),
  z.literal(800),
  z.literal(900),
]);
const IbmPlexMonoWeightSchema = z.union([z.literal(500), z.literal(600), z.literal(700)]);

const DesignTypeRoleV1Schema = z
  .discriminatedUnion("family", [
    z
      .object({
        family: z.literal("Montserrat"),
        weights: z.array(MontserratWeightSchema).min(1).max(5),
      })
      .strict(),
    z
      .object({
        family: z.literal("IBM Plex Mono"),
        weights: z.array(IbmPlexMonoWeightSchema).min(1).max(3),
      })
      .strict(),
  ])
  .superRefine((role, context) => {
    if (new Set(role.weights).size !== role.weights.length) {
      context.addIssue({ code: "custom", message: "Typography weights must be unique" });
    }
  });

const DesignTypographyV1Schema = z
  .object({
    display: DesignTypeRoleV1Schema,
    body: DesignTypeRoleV1Schema,
    mono: DesignTypeRoleV1Schema,
  })
  .strict();

const DesignGeometryV1Schema = z
  .object({
    radiusPx: z.number().int().min(0).max(48),
    borderPx: z.number().int().min(1).max(6),
    shadow: z.enum(["none", "soft", "hard"]),
  })
  .strict();

const DesignTokenBindingsV1Schema = z
  .object({
    background: CssVariableSchema,
    surface: CssVariableSchema,
    text: CssVariableSchema,
    muted: CssVariableSchema,
    accent: CssVariableSchema,
    accentText: CssVariableSchema,
    border: CssVariableSchema,
  })
  .strict()
  .superRefine((bindings, context) => {
    const values = Object.values(bindings);
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Design token bindings must be unique" });
    }
  });

const DesignOriginV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog"), catalogId: DesignCatalogIdSchema }).strict(),
  z
    .object({
      kind: z.literal("reference-derived"),
      fidelity: z.literal("reference-locked"),
      imagePaths: z.array(RelativeDesignPathSchema).min(1).max(4),
      rationale: z.string().trim().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bespoke"),
      rationale: z.string().trim().min(1).max(1_000),
    })
    .strict(),
]);

export const DesignCapsuleV1Schema = z
  .object({
    version: z.literal("sequences.design-capsule.v1"),
    id: StableIdSchema,
    name: z.string().trim().min(1).max(160),
    thesis: z.string().trim().min(1).max(1_500),
    origin: DesignOriginV1Schema,
    basis: z.enum(["light", "dark"]),
    palette: DesignPaletteV1Schema,
    typography: DesignTypographyV1Schema,
    geometry: DesignGeometryV1Schema,
    density: z.enum(["restrained", "balanced", "dense"]),
    compositionDialect: DesignCompositionDialectSchema,
    motionVerbs: z.array(DesignMotionVerbSchema).min(2).max(4),
    rules: z
      .object({
        do: z.array(z.string().trim().min(1).max(500)).min(2).max(5),
        avoid: z.array(z.string().trim().min(1).max(500)).min(2).max(5),
      })
      .strict(),
    rootHfId: StableIdSchema,
    tokenBindings: DesignTokenBindingsV1Schema,
    implementationFiles: z.array(RelativeDesignPathSchema).min(1).max(20),
  })
  .strict()
  .superRefine((capsule, context) => {
    if (new Set(capsule.motionVerbs).size !== capsule.motionVerbs.length) {
      context.addIssue({ code: "custom", message: "Design motion verbs must be unique" });
    }
    if (new Set(capsule.implementationFiles).size !== capsule.implementationFiles.length) {
      context.addIssue({ code: "custom", message: "Design implementation files must be unique" });
    }
    if (
      capsule.origin.kind === "reference-derived" &&
      new Set(capsule.origin.imagePaths).size !== capsule.origin.imagePaths.length
    ) {
      context.addIssue({ code: "custom", message: "Design reference images must be unique" });
    }
  });

export type DesignCapsuleV1 = z.infer<typeof DesignCapsuleV1Schema>;
export type DesignCatalogId = z.infer<typeof DesignCatalogIdSchema>;

type CatalogFoundation = Pick<
  DesignCapsuleV1,
  "basis" | "palette" | "typography" | "geometry" | "density" | "compositionDialect"
> & {
  label: string;
  thesis: string;
};

export const DESIGN_CAPSULE_CATALOG: Record<DesignCatalogId, CatalogFoundation> = {
  "signal-light": {
    label: "Signal Light",
    thesis: "Warm B2B restraint with one decisive cobalt signal and calm product geometry.",
    basis: "light",
    palette: {
      background: "#FDFAF3",
      surface: "#FFFFFF",
      text: "#111418",
      muted: "#5B6066",
      accent: "#1E2BFA",
      accentText: "#FFFFFF",
      border: "#D8D2C6",
    },
    typography: {
      display: { family: "Montserrat", weights: [700, 900] },
      body: { family: "Montserrat", weights: [500, 600] },
      mono: { family: "IBM Plex Mono", weights: [500, 600] },
    },
    geometry: { radiusPx: 12, borderPx: 2, shadow: "none" },
    density: "balanced",
    compositionDialect: "split-evidence",
  },
  "precision-dark": {
    label: "Precision Dark",
    thesis: "Cool technical depth, crisp grid alignment, and one electric product signal.",
    basis: "dark",
    palette: {
      background: "#0B0F14",
      surface: "#121821",
      text: "#E6EDF3",
      muted: "#9CA8B5",
      accent: "#3B82F6",
      accentText: "#07111F",
      border: "#283442",
    },
    typography: {
      display: { family: "Montserrat", weights: [700, 800] },
      body: { family: "Montserrat", weights: [500, 600] },
      mono: { family: "IBM Plex Mono", weights: [500, 700] },
    },
    geometry: { radiusPx: 8, borderPx: 2, shadow: "soft" },
    density: "dense",
    compositionDialect: "full-bleed-product",
  },
  "editorial-warm": {
    label: "Editorial Warm",
    thesis: "Paper warmth, asymmetric editorial measure, and quiet structural authority.",
    basis: "light",
    palette: {
      background: "#EFE7D4",
      surface: "#F6F1E4",
      text: "#1A1A17",
      muted: "#5F594A",
      accent: "#2E4A2A",
      accentText: "#F6F1E4",
      border: "#CFC4AA",
    },
    typography: {
      display: { family: "Montserrat", weights: [600, 800] },
      body: { family: "Montserrat", weights: [500, 600] },
      mono: { family: "IBM Plex Mono", weights: [500, 600] },
    },
    geometry: { radiusPx: 4, borderPx: 1, shadow: "none" },
    density: "restrained",
    compositionDialect: "editorial-diagram",
  },
  "impact-poster": {
    label: "Impact Poster",
    thesis: "Oversized type, hard structural blocks, and one hot launch accent.",
    basis: "light",
    palette: {
      background: "#FFF8F2",
      surface: "#F5ECE6",
      text: "#1C1410",
      muted: "#66584F",
      accent: "#C71F2D",
      accentText: "#FFFFFF",
      border: "#1C1410",
    },
    typography: {
      display: { family: "Montserrat", weights: [800, 900] },
      body: { family: "Montserrat", weights: [500, 600] },
      mono: { family: "IBM Plex Mono", weights: [600, 700] },
    },
    geometry: { radiusPx: 0, borderPx: 4, shadow: "hard" },
    density: "balanced",
    compositionDialect: "poster-to-product",
  },
};
