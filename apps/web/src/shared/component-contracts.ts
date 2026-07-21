import { z } from "zod";

const StableIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/)
  .max(120);

const RelativeComponentPathSchema = z
  .string()
  .min(1)
  .max(180)
  .refine((value) => !value.includes("\\") && !value.startsWith("/") && !value.includes("\0"), {
    message: "Component paths must be project-relative POSIX paths",
  })
  .refine((value) => !value.split("/").some((part) => part === "." || part === ".."), {
    message: "Component paths cannot contain traversal segments",
  });

export const COMPONENT_SLOT_KINDS = [
  "text",
  "number",
  "image",
  "icon",
  "list",
  "progress",
  "code",
] as const;
export const COMPONENT_INTERACTION_KINDS = [
  "press",
  "select",
  "type",
  "submit",
  "toggle",
  "open",
  "close",
  "resolve",
] as const;
export const SAAS_COMPONENT_ARCHETYPES = [
  "app-window",
  "navigation",
  "search",
  "command-palette",
  "button",
  "toggle",
  "toast",
  "modal",
  "stat",
  "data-list",
  "chart",
  "progress",
  "terminal",
  "chat",
  "workflow",
  "custom",
] as const;

const ComponentStateV1Schema = z
  .object({
    id: StableIdSchema,
    description: z.string().trim().min(1).max(500),
  })
  .strict();

const ComponentPartV1Schema = z
  .object({
    id: StableIdSchema,
    hfId: StableIdSchema,
    purpose: z.string().trim().min(1).max(500),
    morphAnchor: z.boolean().optional(),
  })
  .strict();

const ComponentSlotV1Schema = z
  .object({
    id: StableIdSchema,
    hfId: StableIdSchema,
    kind: z.enum(COMPONENT_SLOT_KINDS),
  })
  .strict();

const ComponentInteractionV1Schema = z
  .object({
    id: StableIdSchema,
    kind: z.enum(COMPONENT_INTERACTION_KINDS),
    cause: z.string().trim().min(1).max(500),
    result: z.string().trim().min(1).max(500),
    fromState: StableIdSchema.optional(),
    toState: StableIdSchema.optional(),
  })
  .strict();

export const SaasComponentArchetypeSchema = z.enum(SAAS_COMPONENT_ARCHETYPES);

const ComponentDefinitionV1Schema = z
  .object({
    id: StableIdSchema,
    archetype: SaasComponentArchetypeSchema,
    customArchetypeReason: z.string().trim().min(1).max(500).optional(),
    continuity: z.enum(["persistent", "beat-local"]),
    purpose: z.string().trim().min(1).max(700),
    rootHfId: StableIdSchema,
    stateAttribute: z
      .string()
      .regex(/^data-[a-z][a-z0-9-]*$/)
      .default("data-state"),
    states: z.array(ComponentStateV1Schema).min(1).max(12),
    parts: z.array(ComponentPartV1Schema).min(1).max(32),
    slots: z.array(ComponentSlotV1Schema).max(16).default([]),
    interactions: z.array(ComponentInteractionV1Schema).max(16).default([]),
    usedInBeatIds: z.array(StableIdSchema).min(1).max(50),
    implementationFiles: z.array(RelativeComponentPathSchema).min(1).max(20),
  })
  .strict();

const TokenValueSchema = z.union([
  z.string().max(500),
  z.number().finite().min(-1_000_000).max(1_000_000),
]);

const ReferenceImageStoryBindingV2Schema = z
  .object({
    imagePath: RelativeComponentPathSchema,
    beatIds: z.array(StableIdSchema).min(1).max(50),
    narrativeRole: z.enum(["setup", "action", "proof", "resolution"]),
    purpose: z.string().trim().min(1).max(700),
  })
  .strict();

export const ComponentPlanV2Schema = z
  .object({
    version: z.literal("sequences.component-plan.v2"),
    designCapsuleId: StableIdSchema,
    mode: z.enum(["reference-derived", "synthetic"]),
    name: z.string().trim().min(1).max(160),
    visualThesis: z.string().trim().min(1).max(2_000),
    sourceImages: z.array(RelativeComponentPathSchema).max(4),
    sourceImageBindings: z.array(ReferenceImageStoryBindingV2Schema).max(4).default([]),
    sourceEvidence: z.string().trim().min(1).max(2_000),
    tokens: z.record(StableIdSchema, TokenValueSchema),
    components: z.array(ComponentDefinitionV1Schema).min(1).max(24),
  })
  .strict()
  .superRefine((plan, context) => {
    if (Object.keys(plan.tokens).length > 128) {
      context.addIssue({ code: "custom", message: "Component tokens cannot exceed 128 entries" });
    }
    unique(plan.sourceImages, "source image", context, ["sourceImages"]);
    unique(
      plan.sourceImageBindings.map((binding) => binding.imagePath),
      "source image story binding",
      context,
      ["sourceImageBindings"],
    );
    for (const [bindingIndex, binding] of plan.sourceImageBindings.entries()) {
      unique(binding.beatIds, `story beat in ${binding.imagePath}`, context, [
        "sourceImageBindings",
        bindingIndex,
        "beatIds",
      ]);
    }
    unique(
      plan.components.map((component) => component.id),
      "component id",
      context,
      ["components"],
    );
    unique(
      plan.components.map((component) => component.rootHfId),
      "component root data-hf-id",
      context,
      ["components"],
    );
    const allHfIds = new Set<string>();
    for (const [componentIndex, component] of plan.components.entries()) {
      unique(
        component.states.map((state) => state.id),
        `state id in ${component.id}`,
        context,
        ["components", componentIndex, "states"],
      );
      unique(
        component.parts.map((part) => part.id),
        `part id in ${component.id}`,
        context,
        ["components", componentIndex, "parts"],
      );
      unique(
        component.slots.map((slot) => slot.id),
        `slot id in ${component.id}`,
        context,
        ["components", componentIndex, "slots"],
      );
      unique(
        component.interactions.map((interaction) => interaction.id),
        `interaction id in ${component.id}`,
        context,
        ["components", componentIndex, "interactions"],
      );
      unique(component.usedInBeatIds, `beat use in ${component.id}`, context, [
        "components",
        componentIndex,
        "usedInBeatIds",
      ]);
      unique(component.implementationFiles, `implementation file in ${component.id}`, context, [
        "components",
        componentIndex,
        "implementationFiles",
      ]);
      if (component.archetype === "custom" && !component.customArchetypeReason) {
        context.addIssue({
          code: "custom",
          message: `Custom component ${component.id} needs customArchetypeReason`,
          path: ["components", componentIndex, "customArchetypeReason"],
        });
      }
      if (component.archetype !== "custom" && component.customArchetypeReason) {
        context.addIssue({
          code: "custom",
          message: `Known component ${component.id} cannot declare customArchetypeReason`,
          path: ["components", componentIndex, "customArchetypeReason"],
        });
      }
      const stateIds = new Set(component.states.map((state) => state.id));
      for (const [interactionIndex, interaction] of component.interactions.entries()) {
        for (const [field, stateId] of [
          ["fromState", interaction.fromState],
          ["toState", interaction.toState],
        ] as const) {
          if (stateId && !stateIds.has(stateId)) {
            context.addIssue({
              code: "custom",
              message: `Interaction ${interaction.id} ${field} must name a declared state`,
              path: ["components", componentIndex, "interactions", interactionIndex, field],
            });
          }
        }
      }
      for (const [label, hfId] of [
        ["root", component.rootHfId],
        ...component.parts.map((part) => [`part ${part.id}`, part.hfId]),
      ] as const) {
        if (allHfIds.has(hfId)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate ${label} data-hf-id: ${hfId}`,
            path: ["components", componentIndex],
          });
        }
        allHfIds.add(hfId);
      }
      const partHfIds = new Set(component.parts.map((part) => part.hfId));
      for (const [slotIndex, slot] of component.slots.entries()) {
        if (!partHfIds.has(slot.hfId)) {
          context.addIssue({
            code: "custom",
            message: `Component slot ${slot.id} must target one of its declared parts`,
            path: ["components", componentIndex, "slots", slotIndex, "hfId"],
          });
        }
      }
    }
  });

export type ComponentPlanV2 = z.infer<typeof ComponentPlanV2Schema>;

function unique(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate ${label}: ${value}`,
        path: [...path, index],
      });
    }
    seen.add(value);
  }
}
