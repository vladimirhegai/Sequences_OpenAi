import type { SequenceArtifactV1 } from "../shared";

export const SHOWCASE_CAPSULE_GUIDANCE =
  "Inspect only these selected local capsules as inspiration. Transfer the lessons that fit this brief; do not duplicate an entire film, story, or brand treatment.";

export type ShowcaseCapsuleId =
  | "slack-ad"
  | "chatgpt-ad"
  | "chatgpt-native-story"
  | "sequences-recommendation-ad"
  | "sequences-abstract-ad";

export interface ShowcaseCapsuleSelection {
  id: ShowcaseCapsuleId;
  reference: string;
  contactSheet: string;
  sourceFiles: string[];
  tags: string[];
  useWhen: string;
  lessons: string[];
  mistakes: string[];
}

interface ShowcaseCapsuleDefinition extends ShowcaseCapsuleSelection {
  matches: ReadonlyArray<{ phrase: string; weight: number }>;
}

const CAPSULES: readonly ShowcaseCapsuleDefinition[] = [
  {
    id: "slack-ad",
    reference: ".agents/skills/sequences-saas-launch/references/showcase-slack-ad.md",
    contactSheet: ".agents/skills/sequences-saas-launch/assets/showcase-slack-ad-contact-sheet.jpg",
    sourceFiles: [
      ".agents/skills/sequences-saas-launch/references/showcase-slack-ad-index.html",
      ".agents/skills/sequences-saas-launch/references/showcase-slack-ad-timeline.js",
    ],
    tags: [
      "saas",
      "product-ui",
      "collaboration",
      "measured-geometry",
      "energetic-story",
      "readable-holds",
    ],
    useWhen:
      "The brief needs a clear friction-to-product-to-proof arc, operated collaboration UI, measured camera moves, or an energetic but readable SaaS story.",
    lessons: [
      "Collapse noisy friction into one branded/product focal point before entering UI proof.",
      "Measure camera and interaction geometry, then protect the read hold after each landing.",
      "Carry one desktop and product surface through action, consequence, proof, and the quiet lockup.",
    ],
    mistakes: [
      "Do not copy Slack branding, copy, or its complete beat order.",
      "Do not inherit its historic pre-HyperFrames host shape; use only its transferable craft.",
      "Do not let a superzoom crop the focal text or replay a persistent UI entrance.",
    ],
    matches: [
      { phrase: "slack", weight: 8 },
      { phrase: "collaboration", weight: 5 },
      { phrase: "workspace", weight: 3 },
      { phrase: "team", weight: 2 },
      { phrase: "channel", weight: 3 },
      { phrase: "notification", weight: 2 },
      { phrase: "dashboard", weight: 2 },
      { phrase: "product ui", weight: 3 },
      { phrase: "saas", weight: 2 },
      { phrase: "measured", weight: 2 },
    ],
  },
  {
    id: "chatgpt-ad",
    reference: ".agents/skills/sequences-saas-launch/references/showcase-chatgpt-ad.md",
    contactSheet:
      ".agents/skills/sequences-saas-launch/assets/showcase-chatgpt-ad-contact-sheet.jpg",
    sourceFiles: [
      ".agents/skills/sequences-saas-launch/references/showcase-chatgpt-ad-composer.html",
      ".agents/skills/sequences-saas-launch/references/showcase-chatgpt-ad-work-world.html",
      ".agents/skills/sequences-saas-launch/references/showcase-chatgpt-ad-end-lockup.html",
    ],
    tags: [
      "openai-grammar",
      "chatgpt",
      "kinetic-typography",
      "canonical-knot",
      "product-theater",
      "atomic-close-up",
    ],
    useWhen:
      "The brief calls for OpenAI-like visual grammar, minimal type-led pacing, a canonical knot reveal, a composer close-up, or photographic product theater.",
    lessons: [
      "Sequence a code-native hook, one-thought kinetic type, operated composer, visible consequence, and calm brand resolve.",
      "Use an atomic alternate close-up state when a live zoom would push readable UI outside the frame.",
      "Carry the typed payload into the result world and resolve the knot sprite into the exact vector mark.",
    ],
    mistakes: [
      "Do not redraw an approximate knot or apply OpenAI styling to an unrelated brand by default.",
      "Do not crossfade two readable states or leave one-shot burst from-states parked under seek.",
      "Do not duplicate the film's complete ask-to-planner story.",
    ],
    matches: [
      { phrase: "chatgpt ad", weight: 9 },
      { phrase: "openai", weight: 6 },
      { phrase: "chatgpt", weight: 3 },
      { phrase: "codex", weight: 4 },
      { phrase: "knot", weight: 5 },
      { phrase: "kinetic typography", weight: 5 },
      { phrase: "type led", weight: 4 },
      { phrase: "minimal", weight: 2 },
      { phrase: "composer", weight: 3 },
      { phrase: "product theater", weight: 4 },
      { phrase: "close up", weight: 2 },
    ],
  },
  {
    id: "chatgpt-native-story",
    reference: ".agents/skills/sequences-saas-launch/references/showcase-chatgpt-native-story.md",
    contactSheet:
      ".agents/skills/sequences-saas-launch/assets/showcase-chatgpt-native-story-contact-sheet.jpg",
    sourceFiles: [
      ".agents/skills/sequences-saas-launch/references/showcase-chatgpt-native-story-composition.html",
      ".agents/skills/sequences-saas-launch/references/showcase-chatgpt-native-story-component-plan.json",
    ],
    tags: [
      "authentic-conversation-ui",
      "streaming-response",
      "panel-reflow",
      "measured-pointer",
      "persistent-product-surface",
    ],
    useWhen:
      "The product story lives in a persistent conversational UI with streaming, sources or side panels, document/canvas work, panel reflow, and precise repeated clicks.",
    lessons: [
      "Keep question, response, tools, document work, and completion inside one coherent persistent surface.",
      "Reflow the conversation when a side panel opens instead of laying the panel over readable content.",
      "Resolve pointer destinations from live root-local target centers, including active parent transforms.",
    ],
    mistakes: [
      "Do not turn product features into oversized disconnected cards or a generic dashboard shell.",
      "Do not use a presentation-scale cursor, stage-global ripples, or approximate click coordinates.",
      "Do not let streaming copy become incoherent texture.",
    ],
    matches: [
      { phrase: "conversation", weight: 5 },
      { phrase: "conversational", weight: 5 },
      { phrase: "streaming", weight: 5 },
      { phrase: "chat", weight: 3 },
      { phrase: "assistant", weight: 2 },
      { phrase: "sources", weight: 6 },
      { phrase: "canvas", weight: 5 },
      { phrase: "side panel", weight: 5 },
      { phrase: "reflow", weight: 6 },
      { phrase: "document", weight: 2 },
      { phrase: "chatgpt", weight: 2 },
    ],
  },
  {
    id: "sequences-recommendation-ad",
    reference:
      ".agents/skills/sequences-saas-launch/references/showcase-sequences-recommendation-ad.md",
    contactSheet:
      ".agents/skills/sequences-saas-launch/assets/showcase-sequences-recommendation-ad-contact-sheet.jpg",
    sourceFiles: [
      ".agents/skills/sequences-saas-launch/references/showcase-sequences-recommendation-chat.html",
      ".agents/skills/sequences-saas-launch/references/showcase-sequences-recommendation-product.html",
      ".agents/skills/sequences-saas-launch/references/showcase-sequences-recommendation-sequence.json",
    ],
    tags: [
      "typing-and-clicks",
      "interruption-narrative",
      "glitch",
      "chatgpt-to-product-handoff",
      "storyboard-to-player",
      "audio-sync",
    ],
    useWhen:
      "The story hinges on typing, clicking Generate or Send, an interruption/recommendation turn, or a measured handoff from ChatGPT-like conversation into Sequences product proof.",
    lessons: [
      "Land typing and click SFX on their visible causes; pointer arrival, press, and consequence are distinct phases.",
      "Keep interruption/glitch motion short and bounded to the affected conversation blocks.",
      "Carry the same request into a measured storyboard-card-to-player transformation and verified result.",
    ],
    mistakes: [
      "Do not duplicate the refusal-to-Sequences story or make unsupported product claims.",
      "Do not fire a click on pointer arrival or delay the visible consequence after contact.",
      "Do not let glitch styling destroy the readability of the narrative turn.",
    ],
    matches: [
      { phrase: "recommendation", weight: 7 },
      { phrase: "interrupt", weight: 5 },
      { phrase: "glitch", weight: 6 },
      { phrase: "handoff", weight: 4 },
      { phrase: "generate", weight: 4 },
      { phrase: "send", weight: 3 },
      { phrase: "typing", weight: 4 },
      { phrase: "typewriter", weight: 4 },
      { phrase: "click", weight: 4 },
      { phrase: "pointer", weight: 3 },
      { phrase: "storyboard", weight: 3 },
    ],
  },
  {
    id: "sequences-abstract-ad",
    reference: ".agents/skills/sequences-saas-launch/references/showcase-sequences-abstract-ad.md",
    contactSheet:
      ".agents/skills/sequences-saas-launch/assets/showcase-sequences-abstract-ad-contact-sheet.jpg",
    sourceFiles: [
      ".agents/skills/sequences-saas-launch/references/showcase-sequences-abstract-motion.js",
      ".agents/skills/sequences-saas-launch/references/showcase-sequences-abstract-plan.json",
      ".agents/skills/sequences-saas-launch/references/showcase-sequences-abstract-sfx.md",
    ],
    tags: [
      "abstract-storytelling",
      "semantic-morph",
      "constant-motion",
      "audio-led",
      "density-arc",
      "light-dark-inversion",
    ],
    useWhen:
      "The brief is motion-first, abstract, music-led, morph-heavy, or needs one persistent entity to change meaning continuously across product states.",
    lessons: [
      "Let one semantic object persist through roles such as caret, seed, keyframe, playhead, control, and final mark.",
      "Map macro boundaries and the density peak to the soundtrack; reserve fast multiplication for the musical flurry.",
      "Keep readable copy alive with environmental motion, then resolve accumulated density through subtraction.",
    ],
    mistakes: [
      "Do not substitute decorative particles, random motion, or generic 3D for semantic transformation.",
      "Do not cut between unrelated worlds or let multiple camera owners break continuity.",
      "Do not spread accent color across the whole film; save it for meaningful peaks.",
    ],
    matches: [
      { phrase: "abstract", weight: 8 },
      { phrase: "audio led", weight: 7 },
      { phrase: "music led", weight: 7 },
      { phrase: "music driven", weight: 6 },
      { phrase: "constant motion", weight: 6 },
      { phrase: "morph", weight: 5 },
      { phrase: "continuity", weight: 3 },
      { phrase: "prompt seed", weight: 6 },
      { phrase: "particle", weight: 3 },
      { phrase: "orbit", weight: 3 },
      { phrase: "gradient", weight: 2 },
      { phrase: "rhythm", weight: 3 },
    ],
  },
];

export function selectShowcaseCapsules(
  prompt: string,
  sequence: SequenceArtifactV1 | null = null,
  limit = 2,
): ShowcaseCapsuleSelection[] {
  const corpus = normalizeForMatch(`${prompt} ${sequenceSelectionText(sequence)}`);
  const ranked = CAPSULES.map((capsule, index) => ({
    capsule,
    index,
    score:
      capsule.matches.reduce(
        (score, match) => score + (containsPhrase(corpus, match.phrase) ? match.weight : 0),
        0,
      ) + structuredSequenceBoost(capsule.id, sequence),
  }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = ranked.length > 0 ? ranked : [{ capsule: CAPSULES[0]!, index: 0, score: 0 }];
  return selected.slice(0, Math.max(1, Math.min(limit, 2))).map(({ capsule }) => ({
    id: capsule.id,
    reference: capsule.reference,
    contactSheet: capsule.contactSheet,
    sourceFiles: [...capsule.sourceFiles],
    tags: [...capsule.tags],
    useWhen: capsule.useWhen,
    lessons: [...capsule.lessons],
    mistakes: [...capsule.mistakes],
  }));
}

function sequenceSelectionText(sequence: SequenceArtifactV1 | null): string {
  if (!sequence) return "";
  return [
    sequence.concept.summary,
    ...sequence.concept.hierarchy,
    ...sequence.concept.motionGrammar,
    ...sequence.beats.flatMap((beat) => [
      beat.id,
      beat.role ?? "",
      beat.purpose,
      ...beat.claims.flatMap((claim) => [claim.id, claim.text]),
      ...beat.entities.flatMap((entity) => [entity.id, entity.role, ...entity.parts]),
    ]),
    ...(sequence.transitions ?? []).flatMap((transition) => [
      transition.kind,
      transition.rationale ?? "",
    ]),
    sequence.audio?.soundtrackId ?? "",
    ...(sequence.audio?.cues.map((cue) => cue.kind) ?? []),
  ].join(" ");
}

function structuredSequenceBoost(
  id: ShowcaseCapsuleId,
  sequence: SequenceArtifactV1 | null,
): number {
  if (!sequence) return 0;
  const cueKinds = new Set(sequence.audio?.cues.map((cue) => cue.kind) ?? []);
  let score = 0;
  if (id === "sequences-recommendation-ad") {
    if (cueKinds.has("typing")) score += 5;
    if (cueKinds.has("mouse-click")) score += 5;
  }
  if (id === "chatgpt-native-story" && cueKinds.has("mouse-click")) score += 2;
  if (id === "slack-ad" && sequence.beats.some((beat) => beat.camera)) score += 2;
  if (
    id === "sequences-abstract-ad" &&
    sequence.transitions?.some(({ kind }) => kind === "morph" || kind === "match-cut")
  ) {
    score += 4;
  }
  if (
    id === "chatgpt-ad" &&
    sequence.concept.motionGrammar.some((rule) => /\b(?:knot|kinetic|close-up)\b/i.test(rule))
  ) {
    score += 3;
  }
  return score;
}

function normalizeForMatch(value: string): string {
  return ` ${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

function containsPhrase(corpus: string, phrase: string): boolean {
  return corpus.includes(normalizeForMatch(phrase));
}
