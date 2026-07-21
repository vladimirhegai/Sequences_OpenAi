export interface HyperframesSkillDescription {
  id: string;
  purpose: string;
}

export interface SkillCatalogProfile {
  version: "sequences.skill-profile.v1";
  profileId: string;
  hyperframesVersion: "0.7.56";
  defaultWorkflow: string;
  requiredSkills: readonly string[];
  workflows: readonly string[];
  skills: readonly HyperframesSkillDescription[];
}

/**
 * A small routing catalog for Codex. The skill files stay project-local, but
 * the model only needs this index up front to choose what to read.
 */
export const HYPERFRAMES_SKILLS: readonly HyperframesSkillDescription[] = [
  { id: "hyperframes", purpose: "Entry router for HyperFrames video and composition work." },
  {
    id: "hyperframes-core",
    purpose: "HTML composition contract, timing attributes, clips, and determinism.",
  },
  {
    id: "sequences-saas-launch",
    purpose: "Sequences workflow for fast-paced, product-led SaaS launch films.",
  },
  {
    id: "hyperframes-animation",
    purpose: "Motion rules, scene choreography, transitions, and runtime adapters.",
  },
  {
    id: "hyperframes-keyframes",
    purpose: "Seek-safe keyframes, paths, masks, and motion diagnostics.",
  },
  {
    id: "hyperframes-creative",
    purpose: "Design direction, typography, palettes, beats, and story structure.",
  },
];

export function skillCatalogPrompt(profile: SkillCatalogProfile): string[] {
  return [
    `Skill context gateway: profile ${profile.profileId} (${profile.version}), HyperFrames ${profile.hyperframesVersion}.`,
    "The installed, hash-verified author skills are summarized below:",
    ...profile.skills.map((skill) => `- ${skill.id}: ${skill.purpose}`),
    `Installed workflows: ${profile.workflows.join(", ")}. Default fallback: ${profile.defaultWorkflow}.`,
    "Read each required skill's SKILL.md directly from .agents/skills, then only the references needed for this brief.",
    `Read hyperframes first for the engine boundary, hyperframes-core for the composition contract, then ${profile.defaultWorkflow} for the Sequences launch workflow.`,
    `If the HyperFrames router names a workflow that is not installed, continue with ${profile.defaultWorkflow} and only the installed animation, creative, or keyframe domain references that fit the request.`,
    "Interactive discovery, skill refresh, and workflow-install gates inside skill files are host-owned and already resolved for this autonomous job. Skip those gates and build the requested artifact now.",
    "Use genuine seek-safe motion and the strongest installed HyperFrames capabilities that fit the brief; do not reduce a video request to a static web layout.",
    "Do not run skill update or acquire a missing workflow during an author job.",
    "Do not read every domain skill wholesale. Report only skills actually read in the final response.",
  ];
}
