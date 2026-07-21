/**
 * One-time deterministic audio analysis for the vendored soundtrack catalog.
 *
 * Slack Sequences proved the audio custody model (director chooses, host owns
 * bytes/hashes/muxing) but skipped musical structure entirely — music decorated
 * a finished edit. This script adds the missing piece: for every vendored bed
 * it computes SHA-256, exact duration, an estimated tempo with a beat/bar grid,
 * and a per-second energy map, then writes vendor/audio/catalog.json. The
 * catalog is regenerated only when the vendored bytes change; the stored hash
 * binds each analysis to its exact source file.
 *
 * Usage: bun scripts/analyze-audio.ts [--check]
 *   --check  verify the committed catalog matches the vendored bytes (doctor).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = import.meta.dir ?? dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";

const SAMPLE_RATE = 22_050;
const HOP = 512;

/** Curated editorial metadata; ids are the stable contract the director uses. */
const SOUNDTRACKS = [
  {
    id: "confident-commercial",
    file: "vendor/audio/music/confident_commercial.mp3",
    title: "Confident Commercial",
    mood: "Crisp, confident commercial momentum for a polished SaaS or product launch.",
    gainDb: -13,
  },
  {
    id: "inspirational",
    file: "vendor/audio/music/inspirational.mp3",
    title: "Inspirational Lift",
    mood: "Warm, optimistic lift for a human startup story or emotionally resolved payoff.",
    gainDb: -13,
  },
  {
    id: "fast-pop",
    file: "vendor/audio/music/fast_pop.mp3",
    title: "Fast Pop",
    mood: "Fast, bold pop energy for a punchy reveal or high-confidence launch statement.",
    gainDb: -13,
  },
  {
    id: "funky-commercial",
    file: "vendor/audio/music/funky_commercial.mp3",
    title: "Funky Commercial",
    mood: "Playful funk groove for a personable product with visible personality.",
    gainDb: -13,
  },
  {
    id: "happy-commercial",
    file: "vendor/audio/music/happy_comercial.mp3",
    title: "Happy Commercial",
    mood: "Bright, friendly optimism for approachable tools and team stories.",
    gainDb: -13,
  },
  {
    id: "commercial-hiphop",
    file: "vendor/audio/music/commercial_hiphop2.mp3",
    title: "Commercial Hip-Hop",
    mood: "Modern head-nod hip-hop for a confident developer or creator product.",
    gainDb: -13,
  },
  {
    id: "commercial-jazz",
    file: "vendor/audio/music/commercial_jazz.mp3",
    title: "Commercial Jazz",
    mood: "Relaxed, premium jazz for a calm, sophisticated professional product.",
    gainDb: -13,
  },
  {
    id: "cinematic-violin",
    file: "vendor/audio/music/cinematic_fast_violin.mp3",
    title: "Cinematic Violin",
    mood: "Urgent cinematic strings for high-stakes speed, scale, or security stories.",
    gainDb: -14,
  },
  {
    id: "action-drums",
    file: "vendor/audio/music/action_loud_cinematic_drums.mp3",
    title: "Action Drums",
    mood: "Loud cinematic percussion for a dramatic, high-impact launch moment.",
    gainDb: -15,
  },
  {
    id: "emotional-orchestral",
    file: "vendor/audio/music/emotional_orchestral.mp3",
    title: "Emotional Orchestral",
    mood: "Sweeping orchestral warmth for mission-driven or milestone narratives.",
    gainDb: -13,
  },
  {
    id: "todays-headline",
    file: "vendor/audio/music/todays_headline.mp3",
    title: "Today's Headline",
    mood: "Newsroom urgency for announcement-style launches and feature drops.",
    gainDb: -13,
  },
  {
    id: "deep-hiphop",
    file: "vendor/audio/music/commercial_hiphop.mp3",
    title: "Deep Hip-Hop",
    mood: "Darker, spacious hip-hop for an understated, technical, late-night mood.",
    gainDb: -13,
  },
] as const;

const SFX = [
  {
    kind: "typing",
    file: "vendor/audio/sfx/typing.wav",
    description: "Keyboard typing texture; declare a bounded start/end window while glyphs appear.",
    gainDb: -12,
  },
  {
    kind: "mouse-click",
    file: "vendor/audio/sfx/mouse_click.wav",
    description: "One restrained mouse click at the declared pointer press.",
    gainDb: -4,
  },
  {
    kind: "pop",
    file: "vendor/audio/sfx/mouth_pop.wav",
    description: "Short pop accent for one meaningful reveal, state arrival, or brand punctuation.",
    gainDb: -6,
  },
  {
    kind: "woosh",
    file: "vendor/audio/sfx/woosh.wav",
    description: "Air woosh for one large transition, camera move, or collapse gesture.",
    gainDb: -8,
  },
  {
    kind: "notification",
    file: "vendor/audio/sfx/notification.wav",
    description: "Soft product notification chime for an arriving message, result, or metric.",
    gainDb: -10,
  },
] as const;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function probeDuration(path: string): number {
  const result = spawnSync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`ffprobe failed for ${path}: ${result.stderr}`);
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe reported an invalid duration for ${path}`);
  }
  return Math.round(duration * 1_000) / 1_000;
}

function decodeMono(path: string): Float32Array {
  const result = spawnSync(
    ffmpeg,
    ["-v", "error", "-i", path, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg decode failed for ${path}: ${result.stderr.toString()}`);
  }
  const bytes: Buffer = result.stdout;
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

interface BeatAnalysis {
  bpm: number;
  beatSec: number;
  barSec: number;
  firstBeatSec: number;
  confidence: number;
  energyPerSec: number[];
}

/**
 * Onset autocorrelation tempo estimate with a beat-phase fit. Deliberately
 * simple and fully deterministic: frame RMS -> half-wave rectified log flux ->
 * autocorrelation over 60-200 BPM -> preferred octave in 84-168 BPM -> best
 * grid phase by summed onset strength. Confidence is the winning
 * autocorrelation peak against the envelope's own energy; low-confidence beds
 * still publish duration and energy, with the grid marked unreliable.
 */
function analyzeBeat(samples: Float32Array, durationSec: number): BeatAnalysis {
  const frameCount = Math.floor(samples.length / HOP);
  const rms = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    const start = frame * HOP;
    for (let index = 0; index < HOP; index += 1) {
      const value = samples[start + index] ?? 0;
      sum += value * value;
    }
    rms[frame] = Math.sqrt(sum / HOP);
  }
  const onset = new Float32Array(frameCount);
  for (let frame = 1; frame < frameCount; frame += 1) {
    const flux = Math.log1p(rms[frame]! * 40) - Math.log1p(rms[frame - 1]! * 40);
    onset[frame] = flux > 0 ? flux : 0;
  }
  const framesPerSecond = SAMPLE_RATE / HOP;
  let onsetEnergy = 0;
  for (const value of onset) onsetEnergy += value * value;

  const minLag = Math.round((60 / 200) * framesPerSecond);
  const maxLag = Math.round((60 / 60) * framesPerSecond);
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    for (let frame = 0; frame + lag < frameCount; frame += 1) {
      score += onset[frame]! * onset[frame + lag]!;
    }
    // Mild preference for the 84-168 BPM octave commercial edits cut to.
    const bpm = (60 * framesPerSecond) / lag;
    const octaveWeight = bpm >= 84 && bpm <= 168 ? 1 : 0.72;
    score *= octaveWeight;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  const confidence =
    onsetEnergy > 0 ? Math.round(Math.min(1, bestScore / onsetEnergy) * 100) / 100 : 0;
  const beatSec = bestLag / framesPerSecond;
  const bpm = Math.round((60 / beatSec) * 10) / 10;

  let bestPhase = 0;
  let bestPhaseScore = -1;
  for (let phase = 0; phase < bestLag; phase += 1) {
    let score = 0;
    for (let frame = phase; frame < frameCount; frame += bestLag) score += onset[frame]!;
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = phase;
    }
  }
  const firstBeatSec = Math.round((bestPhase / framesPerSecond) * 1_000) / 1_000;

  const energyPerSec: number[] = [];
  const buckets = Math.min(Math.ceil(durationSec), 240);
  let peak = 0;
  for (let second = 0; second < buckets; second += 1) {
    const from = Math.floor(second * framesPerSecond);
    const to = Math.min(frameCount, Math.floor((second + 1) * framesPerSecond));
    let sum = 0;
    for (let frame = from; frame < to; frame += 1) sum += rms[frame]!;
    const value = to > from ? sum / (to - from) : 0;
    energyPerSec.push(value);
    peak = Math.max(peak, value);
  }
  const normalized = energyPerSec.map((value) =>
    peak > 0 ? Math.round((value / peak) * 100) / 100 : 0,
  );

  return {
    bpm,
    beatSec: Math.round(beatSec * 10_000) / 10_000,
    barSec: Math.round(beatSec * 4 * 10_000) / 10_000,
    firstBeatSec,
    confidence,
    energyPerSec: normalized,
  };
}

function buildCatalog(): Record<string, unknown> {
  return {
    version: "sequences.audio-catalog.v1",
    generatedBy: "scripts/analyze-audio.ts",
    sampleRate: SAMPLE_RATE,
    soundtracks: SOUNDTRACKS.map((entry) => {
      const path = join(root, ...entry.file.split("/"));
      const durationSec = probeDuration(path);
      const analysis = analyzeBeat(decodeMono(path), durationSec);
      return { ...entry, sha256: sha256(path), durationSec, analysis };
    }),
    sfx: SFX.map((entry) => {
      const path = join(root, ...entry.file.split("/"));
      return { ...entry, sha256: sha256(path), durationSec: probeDuration(path) };
    }),
  };
}

const catalogPath = join(root, "vendor", "audio", "catalog.json");

if (process.argv.includes("--check")) {
  const committed = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    soundtracks: Array<{ file: string; sha256: string }>;
    sfx: Array<{ file: string; sha256: string }>;
  };
  const failures: string[] = [];
  for (const entry of [...committed.soundtracks, ...committed.sfx]) {
    const actual = sha256(join(root, ...entry.file.split("/")));
    if (actual !== entry.sha256)
      failures.push(
        `${entry.file}: catalog ${entry.sha256.slice(0, 12)}… != file ${actual.slice(0, 12)}…`,
      );
  }
  if (failures.length > 0) {
    console.error(`audio catalog is stale:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log(
    `audio catalog verified: ${committed.soundtracks.length} soundtracks, ${committed.sfx.length} sfx`,
  );
} else {
  const catalog = buildCatalog();
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const soundtracks = catalog.soundtracks as Array<{
    id: string;
    durationSec: number;
    analysis: BeatAnalysis;
  }>;
  for (const entry of soundtracks) {
    console.log(
      `${entry.id}: ${entry.durationSec}s, ~${entry.analysis.bpm} BPM (confidence ${entry.analysis.confidence}), bar ${entry.analysis.barSec}s`,
    );
  }
  console.log(`wrote ${catalogPath}`);
}
