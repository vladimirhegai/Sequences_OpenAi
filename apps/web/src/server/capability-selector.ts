import type { SequenceArtifactV1 } from "../shared";

export interface AuthorCapabilityHint {
  id: string;
  purpose: string;
  skill: "hyperframes-animation" | "hyperframes-creative";
  reference: string;
  candidateReferences?: string[];
  constraints: string[];
}

interface RankedCapability extends AuthorCapabilityHint {
  keywords: readonly string[];
  baseline?: boolean;
}

const CAPABILITIES: readonly RankedCapability[] = [
  {
    id: "intentional-boundaries",
    purpose: "Choose a coherent handoff grammar; hard cuts remain valid.",
    skill: "hyperframes-animation",
    reference: "transitions/overview.md",
    constraints: ["One mechanical owner per boundary", "Use only locally supplied runtimes"],
    keywords: ["transition", "cut", "launch", "promo", "ad"],
    baseline: true,
  },
  {
    id: "camera-targeting",
    purpose: "Move one world owner toward a semantic product target.",
    skill: "hyperframes-animation",
    reference: "rules/coordinate-target-zoom.md",
    constraints: ["Bake fixed target coordinates", "Keep timeline registration synchronous"],
    keywords: ["camera", "zoom", "push", "pan", "focus", "superzoom", "dolly"],
  },
  {
    id: "multi-phase-camera",
    purpose: "Compose travel, settle, dwell, and departure as one camera phrase.",
    skill: "hyperframes-animation",
    reference: "rules/multi-phase-camera.md",
    constraints: ["One world wrapper owns camera transforms", "Protect the landing hold"],
    keywords: ["camera", "cinematic", "travel", "orbit", "dolly", "perspective"],
  },
  {
    id: "identity-morph",
    purpose: "Preserve one product entity across an identity-aware morph or match cut.",
    skill: "hyperframes-animation",
    reference: "rules/card-morph-anchor.md",
    constraints: ["Declare outgoing and incoming entities", "Use stable morph anchors"],
    keywords: [
      "morph",
      "match",
      "identity",
      "preserving",
      "transform",
      "expand",
      "collapse",
      "continuity",
    ],
  },
  {
    id: "product-cursor-action",
    purpose: "Stage a deterministic cursor action with visible UI consequence.",
    skill: "hyperframes-animation",
    reference: "rules/cursor-click-ripple.md",
    candidateReferences: [
      "compositions/_primitives/pointer-action.js",
      "compositions/_primitives/pointer-action.example.html",
    ],
    constraints: [
      "Start from the candidate-local pointer primitive and measured hotspot geometry",
      "Pass the composition root element itself as the helper root; never query for the root inside itself",
      "Keep the pointer target and its ancestors layout-measurable when the helper initializes; use opacity or visibility instead of display:none before measurement",
      "The click must cause the next product state",
    ],
    keywords: [
      "cursor",
      "pointer",
      "click",
      "press",
      "workflow",
      "dashboard",
      "demo",
      "product",
      "ui",
    ],
  },
  {
    id: "product-typewriter",
    purpose: "Type into a product control with glyph-accurate caret placement and audio markers.",
    skill: "hyperframes-animation",
    reference: "rules/discrete-text-sequence.md",
    candidateReferences: [
      "compositions/_primitives/typewriter.js",
      "compositions/_primitives/typewriter.example.html",
    ],
    constraints: [
      "Start from the candidate-local typewriter primitive",
      "Prove empty, midpoint, complete, and caret-removal states",
    ],
    keywords: ["typewriter", "typing", "typed", "input", "prompt", "composer", "field", "chat"],
  },
  {
    id: "metric-proof",
    purpose: "Animate product evidence without layout jitter or arbitrary counters.",
    skill: "hyperframes-animation",
    reference: "rules/counting-dynamic-scale.md",
    constraints: [
      "Use credible prompt-grounded values",
      "Hold the final value long enough to read",
    ],
    keywords: ["metric", "number", "growth", "percent", "count", "data", "analytics", "proof"],
  },
  {
    id: "kinetic-copy-sequence",
    purpose: "Sequence short launch copy while keeping one clear reading owner.",
    skill: "hyperframes-animation",
    reference: "rules/discrete-text-sequence.md",
    constraints: ["Do not replace product proof with typography", "Keep copy inside safe margins"],
    keywords: ["headline", "text", "type", "copy", "word", "editorial"],
  },
  {
    id: "collaboration-network",
    purpose: "Show people, agents, or work moving through a legible network.",
    skill: "hyperframes-animation",
    reference: "rules/avatar-cloud-network.md",
    constraints: ["Keep nodes semantically meaningful", "Avoid decorative particle noise"],
    keywords: ["team", "collaboration", "network", "agent", "people", "workspace", "slack"],
  },
  {
    id: "product-frame-density",
    purpose: "Compose code-native product UI with video-scale hierarchy and foreground detail.",
    skill: "hyperframes-creative",
    reference: "references/video-composition.md",
    constraints: ["Show recognizable product state", "Avoid centered card-deck monoculture"],
    keywords: ["saas", "software", "app", "dashboard", "product", "interface", "ui"],
    baseline: true,
  },
];

export function selectAuthorCapabilities(
  prompt: string,
  sequence: SequenceArtifactV1 | null = null,
  limit = 6,
): AuthorCapabilityHint[] {
  const words = new Set(
    `${prompt} ${sequenceCapabilityText(sequence)}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
  const ranked = CAPABILITIES.map((capability) => ({
    capability,
    score:
      capability.keywords.reduce((score, keyword) => score + (words.has(keyword) ? 1 : 0), 0) +
      (capability.baseline ? 0.25 : 0) +
      structuredSequenceBoost(capability.id, sequence),
  }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.capability.id.localeCompare(right.capability.id),
    );
  const requiredIds = requiredCapabilityIds(sequence);
  return [
    ...ranked.filter(({ capability }) => requiredIds.has(capability.id)),
    ...ranked.filter(({ capability }) => !requiredIds.has(capability.id)),
  ]
    .slice(0, Math.max(1, Math.min(limit, 6)))
    .map(({ capability: { keywords: _keywords, baseline: _baseline, ...hint } }) => hint);
}

function requiredCapabilityIds(sequence: SequenceArtifactV1 | null): Set<string> {
  const ids = new Set(CAPABILITIES.filter(({ baseline }) => baseline).map(({ id }) => id));
  if (!sequence) return ids;
  if (sequence.beats.some((beat) => beat.camera)) {
    ids.add("camera-targeting");
    ids.add("multi-phase-camera");
  }
  if (sequence.transitions?.some(({ kind }) => kind === "morph" || kind === "match-cut")) {
    ids.add("identity-morph");
  }
  if (
    sequence.concept.motionGrammar.some((rule) =>
      /\b(?:cursor|pointer|click|press)\b/i.test(rule),
    ) ||
    sequence.audio?.cues.some(({ kind }) => kind === "mouse-click")
  ) {
    ids.add("product-cursor-action");
  }
  if (
    sequence.concept.motionGrammar.some((rule) =>
      /\b(?:typewriter|typing|typed|input)\b/i.test(rule),
    ) ||
    sequence.audio?.cues.some(({ kind }) => kind === "typing")
  ) {
    ids.add("product-typewriter");
  }
  return ids;
}

function sequenceCapabilityText(sequence: SequenceArtifactV1 | null): string {
  if (!sequence) return "";
  return [
    sequence.concept.summary,
    ...sequence.concept.hierarchy,
    ...sequence.concept.motionGrammar,
    ...sequence.beats.flatMap((beat) => [
      beat.id,
      beat.role ?? "",
      beat.purpose,
      ...beat.entities.flatMap((entity) => [entity.id, entity.role, ...entity.parts]),
    ]),
    ...(sequence.transitions ?? []).flatMap((transition) => [
      transition.kind,
      transition.rationale ?? "",
    ]),
    ...(sequence.audio?.cues ?? []).map(({ kind }) => kind),
  ].join(" ");
}

function structuredSequenceBoost(id: string, sequence: SequenceArtifactV1 | null): number {
  if (!sequence) return 0;
  if (
    ["camera-targeting", "multi-phase-camera"].includes(id) &&
    sequence.beats.some((beat) => beat.camera)
  ) {
    return 3;
  }
  if (
    id === "identity-morph" &&
    sequence.transitions?.some(({ kind }) => kind === "morph" || kind === "match-cut")
  ) {
    return 3;
  }
  if (
    id === "product-cursor-action" &&
    (sequence.concept.motionGrammar.some((rule) =>
      /\b(?:cursor|pointer|click|press)\b/i.test(rule),
    ) ||
      sequence.audio?.cues.some(({ kind }) => kind === "mouse-click"))
  ) {
    return 3;
  }
  if (
    id === "product-typewriter" &&
    (sequence.concept.motionGrammar.some((rule) =>
      /\b(?:typewriter|typing|typed|input)\b/i.test(rule),
    ) ||
      sequence.audio?.cues.some(({ kind }) => kind === "typing"))
  ) {
    return 3;
  }
  return 0;
}
