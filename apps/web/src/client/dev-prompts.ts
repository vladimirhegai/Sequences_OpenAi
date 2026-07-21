export interface DevPromptTemplate {
  id: string;
  label: string;
  prompt: string;
}

// Vite removes this branch from production builds. These are intentionally
// small prompts for iterating on the foundation, not user-facing presets.
export const DEV_PROMPTS: DevPromptTemplate[] = import.meta.env.DEV
  ? [
      {
        id: "kinetic-title",
        label: "Kinetic title",
        prompt:
          "Create a short 8–10 second kinetic title video about [topic]. Use one clear headline, a simple supporting line, and deliberate motion that settles into a readable hold.",
      },
      {
        id: "simple-explainer",
        label: "Simple explainer",
        prompt:
          "Create a 15-second visual explainer about [topic]. Show the idea in three simple beats: setup, change, and result. Keep the composition generic, legible, and easy to scrub.",
      },
      {
        id: "before-after",
        label: "Before / after",
        prompt:
          "Create a 15-second before-and-after video about [topic]. Keep one visual subject across the change, use a restrained transition, and finish on a clear result card.",
      },
    ]
  : [];
