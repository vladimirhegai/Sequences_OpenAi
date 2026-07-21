/**
 * Host-owned audio custody, adopted from the proven Slack Sequences
 * `audioContract.ts` model and adapted to the Sequences pipeline:
 *
 * - The director declares one catalog `soundtrackId` plus bounded semantic SFX
 *   cues inside `sequence.json` (`audio`), the same semantic artifact that owns
 *   beats and transitions — never a parallel plan file.
 * - The host owns the vendored bytes, SHA-256 verification, gain, fades,
 *   looping, limiting, and FFmpeg muxing. Model-authored paths or filter
 *   graphs never cross this boundary.
 * - `vendor/audio/catalog.json` is generated once by `scripts/analyze-audio.ts`
 *   and carries the piece the donor skipped: a deterministic beat/energy map
 *   per bed (BPM, beat/bar grid, per-second energy) bound to the audio hash,
 *   so cuts can land on musical structure instead of music decorating a
 *   finished edit.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AUDIO_SFX_KINDS, type AudioDirectionV1, type SequenceArtifactV1 } from "../shared";

const BeatAnalysisSchema = z
  .object({
    bpm: z.number().finite().positive().max(300),
    beatSec: z.number().finite().positive().max(10),
    barSec: z.number().finite().positive().max(40),
    firstBeatSec: z.number().finite().nonnegative().max(60),
    confidence: z.number().finite().min(0).max(1),
    energyPerSec: z.array(z.number().finite().min(0).max(1)).max(300),
  })
  .strict();

const SoundtrackEntrySchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(60),
    file: z.string().regex(/^vendor\/audio\/music\/[\w.-]+\.mp3$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    title: z.string().min(1).max(120),
    mood: z.string().min(1).max(300),
    gainDb: z.number().finite().min(-40).max(0),
    durationSec: z.number().finite().positive().max(600),
    analysis: BeatAnalysisSchema,
  })
  .strict();

const SfxEntrySchema = z
  .object({
    kind: z.enum(AUDIO_SFX_KINDS),
    file: z.string().regex(/^vendor\/audio\/sfx\/[\w.-]+\.wav$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    description: z.string().min(1).max(300),
    gainDb: z.number().finite().min(-40).max(0),
    durationSec: z.number().finite().positive().max(60),
  })
  .strict();

export const AudioCatalogSchema = z
  .object({
    version: z.literal("sequences.audio-catalog.v1"),
    generatedBy: z.literal("scripts/analyze-audio.ts"),
    sampleRate: z.number().int().positive(),
    soundtracks: z.array(SoundtrackEntrySchema).min(1).max(30),
    sfx: z.array(SfxEntrySchema).min(1).max(20),
  })
  .strict()
  .superRefine((catalog, context) => {
    const kinds = new Set(catalog.sfx.map((entry) => entry.kind));
    for (const kind of AUDIO_SFX_KINDS) {
      if (!kinds.has(kind)) {
        context.addIssue({ code: "custom", message: `audio catalog is missing sfx kind ${kind}` });
      }
    }
  });

export type AudioCatalog = z.infer<typeof AudioCatalogSchema>;
export type AudioSoundtrackEntry = AudioCatalog["soundtracks"][number];

const MAX_AUDIO_CUES = 20;
const MAX_TYPING_WINDOW_SEC = 8;
const CUE_BUDGETS: Record<(typeof AUDIO_SFX_KINDS)[number], number> = {
  typing: 4,
  "mouse-click": 12,
  pop: 6,
  woosh: 8,
  notification: 8,
};

export class AudioDirector {
  private catalog: AudioCatalog | null = null;

  constructor(private readonly workspaceRoot: string) {}

  async load(): Promise<AudioCatalog> {
    if (this.catalog) return this.catalog;
    const raw = await readFile(join(this.workspaceRoot, "vendor", "audio", "catalog.json"), "utf8");
    this.catalog = AudioCatalogSchema.parse(JSON.parse(raw) as unknown);
    return this.catalog;
  }

  /**
   * Semantic-contract validation for the authored sound plan. Objective truth
   * only: catalog membership, time bounds, per-kind budgets, duplicates. What
   * the soundtrack sounds like against the story remains the director's taste.
   */
  async assertAudioDirection(sequence: SequenceArtifactV1): Promise<void> {
    const audio = sequence.audio;
    if (!audio) return;
    const catalog = await this.load();
    const failures: string[] = [];
    const durationSec = sequence.format?.targetDuration ?? 0;
    if (durationSec <= 0) {
      failures.push("sequence.json audio requires format.targetDuration");
    }
    if (!catalog.soundtracks.some((entry) => entry.id === audio.soundtrackId)) {
      failures.push(
        `sequence.json audio.soundtrackId is not in the host catalog: ${audio.soundtrackId}`,
      );
    }
    if (audio.cues.length > MAX_AUDIO_CUES) {
      failures.push(`sequence.json audio may declare at most ${MAX_AUDIO_CUES} cues`);
    }
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const [index, cue] of audio.cues.entries()) {
      counts.set(cue.kind, (counts.get(cue.kind) ?? 0) + 1);
      if (cue.kind === "typing") {
        if (
          durationSec > 0 &&
          (cue.endSec <= cue.startSec ||
            cue.endSec > durationSec + 0.001 ||
            cue.endSec - cue.startSec > MAX_TYPING_WINDOW_SEC)
        ) {
          failures.push(
            `sequence.json audio typing cue ${index + 1} needs a bounded window inside the film (max ${MAX_TYPING_WINDOW_SEC}s)`,
          );
        }
        const key = `typing:${cue.startSec}:${cue.endSec}`;
        if (seen.has(key))
          failures.push(`sequence.json audio cue ${index + 1} duplicates another cue`);
        seen.add(key);
      } else {
        if (durationSec > 0 && cue.atSec >= durationSec) {
          failures.push(`sequence.json audio ${cue.kind} cue ${index + 1} is outside the film`);
        }
        const key = `${cue.kind}:${cue.atSec}`;
        if (seen.has(key))
          failures.push(`sequence.json audio cue ${index + 1} duplicates another cue`);
        seen.add(key);
      }
    }
    for (const kind of AUDIO_SFX_KINDS) {
      if ((counts.get(kind) ?? 0) > CUE_BUDGETS[kind]) {
        failures.push(`sequence.json audio exceeds the ${kind} cue budget of ${CUE_BUDGETS[kind]}`);
      }
    }
    const unique = [...new Set(failures)];
    if (unique.length === 1) throw new Error(unique[0]);
    if (unique.length > 1) {
      throw new Error(
        `sequence.json audio direction found ${unique.length} mismatches:\n${unique
          .map((failure, index) => `${index + 1}. ${failure}`)
          .join("\n")}`,
      );
    }
  }

  /**
   * Compact catalog for the author context: enough to choose a bed and land
   * beat boundaries on its bar grid, small enough for the context budget.
   * Energy is compressed to coarse thirds so a 220-second bed stays compact.
   */
  async authorCatalog(): Promise<Record<string, unknown>> {
    const catalog = await this.load();
    return {
      authority:
        "Optional but recommended for launch films: declare sequence.json audio with one catalog soundtrackId and only meaningful semantic cues. The host owns files, levels, fades, looping, and muxing. The bed plays from its own time 0; where the analysis confidence is high, land beat boundaries and the energy peak near bar multiples of barSec offset by firstBeatSec.",
      soundtracks: catalog.soundtracks.map((entry) => ({
        id: entry.id,
        title: entry.title,
        mood: entry.mood,
        durationSec: entry.durationSec,
        bpm: entry.analysis.bpm,
        barSec: entry.analysis.barSec,
        firstBeatSec: entry.analysis.firstBeatSec,
        beatConfidence: entry.analysis.confidence,
        openingEnergy: coarseEnergy(entry.analysis.energyPerSec.slice(0, 30)),
      })),
      sfx: catalog.sfx.map((entry) => ({
        kind: entry.kind,
        description: entry.description,
        durationSec: entry.durationSec,
      })),
      cueShapes: [
        { kind: "typing", startSec: "number", endSec: "number (window <= 8s)" },
        { kind: "mouse-click | pop | woosh | notification", atSec: "number" },
      ],
    };
  }

  /** Verify the vendored bytes still match the committed catalog hashes. */
  async verifySources(): Promise<void> {
    const catalog = await this.load();
    for (const entry of [...catalog.soundtracks, ...catalog.sfx]) {
      const bytes = await readFile(join(this.workspaceRoot, ...entry.file.split("/")));
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== entry.sha256) {
        throw new Error(`vendored audio failed SHA-256 verification: ${entry.file}`);
      }
    }
  }

  /**
   * Build the exact FFmpeg invocation that adds the directed sound plan to a
   * silent producer MP4. Pure planning — the caller executes it and performs
   * the atomic replace. Filter-graph structure follows the donor's proven mix:
   * looped/trimmed bed with edge fades, delayed one-shot/windowed cues, one
   * normalize-free amix, then a limiter.
   */
  async mixPlan(input: {
    videoPath: string;
    outputPath: string;
    sequence: SequenceArtifactV1;
  }): Promise<{ args: string[]; soundtrackId: string; cueCount: number } | null> {
    const audio = input.sequence.audio;
    if (!audio) return null;
    await this.assertAudioDirection(input.sequence);
    await this.verifySources();
    const catalog = await this.load();
    const durationSec = input.sequence.format!.targetDuration;
    const bed = catalog.soundtracks.find((entry) => entry.id === audio.soundtrackId)!;
    const sfxByKind = new Map(catalog.sfx.map((entry) => [entry.kind, entry]));

    const args: string[] = ["-y", "-i", input.videoPath];
    args.push("-stream_loop", "-1", "-i", join(this.workspaceRoot, ...bed.file.split("/")));
    const filters: string[] = [];
    const labels: string[] = [];
    const fadeOutDuration = Math.min(0.65, durationSec / 2);
    const fadeOutStart = Math.max(0, durationSec - fadeOutDuration);
    filters.push(
      `[1:a]atrim=start=0:end=${seconds(durationSec)},asetpts=PTS-STARTPTS,` +
        `aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `volume=${amplitude(bed.gainDb)},afade=t=in:st=0:d=${seconds(Math.min(0.25, durationSec / 3))},` +
        `afade=t=out:st=${seconds(fadeOutStart)}:d=${seconds(fadeOutDuration)}[audio0]`,
    );
    labels.push("[audio0]");
    let inputIndex = 2;
    for (const [cueIndex, cue] of audio.cues.entries()) {
      const entry = sfxByKind.get(cue.kind)!;
      args.push("-i", join(this.workspaceRoot, ...entry.file.split("/")));
      const label = `audio${cueIndex + 1}`;
      if (cue.kind === "typing") {
        const cueDuration = cue.endSec - cue.startSec;
        const edgeFade = Math.min(0.03, cueDuration / 4);
        filters.push(
          `[${inputIndex}:a]atrim=start=0:end=${seconds(cueDuration)},asetpts=PTS-STARTPTS,` +
            `aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
            `volume=${amplitude(entry.gainDb)},afade=t=in:st=0:d=${seconds(edgeFade)},` +
            `afade=t=out:st=${seconds(Math.max(0, cueDuration - edgeFade))}:d=${seconds(edgeFade)},` +
            `adelay=${milliseconds(cue.startSec)}:all=1[${label}]`,
        );
      } else {
        filters.push(
          `[${inputIndex}:a]atrim=start=0:end=${seconds(entry.durationSec)},asetpts=PTS-STARTPTS,` +
            `aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
            `volume=${amplitude(entry.gainDb)},adelay=${milliseconds(cue.atSec)}:all=1[${label}]`,
        );
      }
      labels.push(`[${label}]`);
      inputIndex += 1;
    }
    filters.push(
      `${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,` +
        `alimiter=limit=0.95,atrim=start=0:end=${seconds(durationSec)}[audio]`,
    );
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "0:v:0",
      "-map",
      "[audio]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-t",
      seconds(durationSec),
      "-movflags",
      "+faststart",
      input.outputPath,
    );
    return { args, soundtrackId: bed.id, cueCount: audio.cues.length };
  }
}

/** Collapse a per-second energy list into coarse thirds for compact context. */
function coarseEnergy(energyPerSec: readonly number[]): number[] {
  if (energyPerSec.length === 0) return [];
  const third = Math.max(1, Math.ceil(energyPerSec.length / 3));
  const output: number[] = [];
  for (let index = 0; index < energyPerSec.length; index += third) {
    const slice = energyPerSec.slice(index, index + third);
    const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length;
    output.push(Math.round(mean * 100) / 100);
  }
  return output.slice(0, 3);
}

function amplitude(db: number): string {
  return Math.pow(10, db / 20).toFixed(6);
}

function seconds(value: number): string {
  const fixed = value.toFixed(3).replace(/\.?0+$/, "");
  return fixed === "" || fixed === "-" ? "0" : fixed;
}

function milliseconds(value: number): number {
  return Math.max(0, Math.round(value * 1_000));
}

export type { AudioDirectionV1 };
