import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TemporalEvidenceV1Schema,
  type SequenceArtifactV1,
  type TemporalEvidenceV1,
  type VisualAuditReportV1,
} from "../shared";
import { atomicWriteJson, existingFileWithin, sha256 } from "./files";

export const CREATIVE_STAGE_PATHS = [
  "frame.md",
  "sequence.json",
  "story/design-capsule.json",
] as const;

export const componentStagePaths = ["story/component-plan.json"] as const;

export const PREPRODUCTION_STAGE_PATHS = [...CREATIVE_STAGE_PATHS, ...componentStagePaths] as const;

export function missingPreproductionPaths(changedFiles: readonly string[]): string[] {
  const changed = new Set(changedFiles);
  return PREPRODUCTION_STAGE_PATHS.filter((path) => !changed.has(path));
}

const COMPOSITOR_RENDER_PATHS = [
  "index.html",
  "meta.json",
  "hyperframes.json",
  "compositions/**",
  "scenes/**",
  "assets/derived/**",
  "index.motion.json",
] as const;

export interface ArtifactDigest {
  path: string;
  sha256: string;
  bytes: number;
}

interface TemporalSample {
  at: number;
  judgment: "transit" | "landed";
  beatId: string | null;
  transitionId: string | null;
  entityIds: string[];
  labels: string[];
}

interface EvidenceImage {
  artifact: string;
  sha256: string;
  at: number | null;
}

const INTERACTION_SAMPLE_LABELS = new Set([
  "typing-start",
  "typing-mid",
  "typing-end",
  "pointer-approach",
  "pointer-contact",
  "pointer-consequence",
]);
const POINTER_PHASE_OFFSET_SEC = 0.2;

export function needsComponentArchitect(
  prompt: string,
  imageCount: number,
  sequence?: SequenceArtifactV1 | null,
): boolean {
  if (imageCount > 0) return true;
  if (sequence?.transitions?.some(({ kind }) => kind === "morph" || kind === "match-cut")) {
    return true;
  }

  const normalized = prompt.toLowerCase().replace(/[_-]+/g, " ");
  return [
    /\bliquid\s+glass\b/,
    /\bmorph(?:s|ed|ing)?\b/,
    /\b(?:recreate|rebuild|replicate)\b.{0,80}\b(?:screenshots?|images?)\b/,
    /\b(?:ui|interface)\b.{0,40}\bfrom\b.{0,30}\b(?:screenshots?|images?)\b/,
    /\bfrom\s+(?:an?\s+|the\s+)?(?:screenshots?|images?)\b/,
  ].some((pattern) => pattern.test(normalized));
}

export function compositorStagePaths(componentSpecialist: boolean): string[] {
  return [...COMPOSITOR_RENDER_PATHS, ...(componentSpecialist ? [] : componentStagePaths)];
}

export async function captureArtifactDigests(
  candidateRoot: string,
  paths: readonly string[],
): Promise<ArtifactDigest[]> {
  const digests: ArtifactDigest[] = [];
  for (const path of [...new Set(paths)]) {
    const file = await existingFileWithin(candidateRoot, path);
    const contents = await readFile(file);
    digests.push({ path, sha256: sha256(contents), bytes: contents.byteLength });
  }
  return digests;
}

export async function assertArtifactDigests(
  candidateRoot: string,
  expected: readonly ArtifactDigest[],
): Promise<void> {
  for (const digest of expected) {
    let actual: ArtifactDigest;
    try {
      actual = (await captureArtifactDigests(candidateRoot, [digest.path]))[0]!;
    } catch {
      throw new Error(`Locked workflow artifact changed or disappeared: ${digest.path}`);
    }
    if (actual.sha256 !== digest.sha256 || actual.bytes !== digest.bytes) {
      throw new Error(`Locked workflow artifact changed or disappeared: ${digest.path}`);
    }
  }
}

export async function createTemporalEvidence(
  runRoot: string,
  sequence: SequenceArtifactV1,
  qaArtifact: string,
  evidenceImages: readonly string[],
): Promise<TemporalEvidenceV1> {
  const format = sequence.format;
  if (!format) throw new Error("Temporal evidence requires an explicit sequence format");
  const samples = temporalSamples(sequence, format.fps, format.targetDuration);
  const images = await evidenceImageDigests(runRoot, evidenceImages);
  const assignments = assignEvidenceImages(
    samples,
    images,
    Math.max(0.051, 1 / format.fps + 0.001),
  );
  const frames = assignments
    .sort((left, right) => left.sample.at - right.sample.at)
    .slice(0, 40)
    .map(({ sample, image }, index) => ({
      id: `temporal-${String(index + 1).padStart(2, "0")}`,
      // The image timestamp is disk truth. Never relabel a nearby generic QA
      // snapshot as if it proved a different semantic instant.
      at: image.at!,
      judgment: sample.judgment,
      beatId: sample.beatId,
      transitionId: sample.transitionId,
      entityIds: sample.entityIds,
      labels: sample.labels,
      artifact: image.artifact,
      sha256: image.sha256,
    }));
  const evidence = TemporalEvidenceV1Schema.parse({
    version: "sequences.temporal-evidence.v1",
    duration: format.targetDuration,
    qaArtifact,
    frames,
  });
  await atomicWriteJson(
    join(runRoot, "workflow", "temporal-evidence.json"),
    TemporalEvidenceV1Schema,
    evidence,
  );
  return evidence;
}

/**
 * Selects the exact story instants the final creative auditor must see.
 * Interaction phases are selected first so typing and operated clicks cannot
 * be displaced by generic coverage. Remaining slots include the opening, one
 * proof per beat, the final hold, identity transitions, camera landings, and
 * finally the broader semantic sample set.
 */
export function temporalEvidenceSnapshotTimes(sequence: SequenceArtifactV1, limit = 12): number[] {
  const format = sequence.format;
  if (!format) throw new Error("Temporal evidence requires an explicit sequence format");
  const boundedLimit = Math.max(1, Math.min(40, Math.floor(limit)));
  const samples = temporalSamples(sequence, format.fps, format.targetDuration);
  const selected = new Map<number, true>();
  const add = (sample: TemporalSample | undefined) => {
    if (!sample || selected.size >= boundedLimit) return;
    selected.set(sample.at, true);
  };
  const sampleWith = (predicate: (sample: TemporalSample) => boolean) => samples.find(predicate);

  for (const sample of samples) {
    if (sample.labels.some((label) => INTERACTION_SAMPLE_LABELS.has(label))) add(sample);
  }
  add(sampleWith((sample) => sample.labels.includes("opening-state")));
  for (const beat of sequence.beats) {
    add(sampleWith((sample) => sample.beatId === beat.id && sample.labels.includes("beat-proof")));
  }
  add(sampleWith((sample) => sample.labels.includes("final-hold")));
  for (const transition of sequence.transitions ?? []) {
    if (!["morph", "match-cut"].includes(transition.kind)) continue;
    add(
      sampleWith(
        (sample) =>
          sample.transitionId === transition.id && sample.labels.includes("transition-mid"),
      ),
    );
  }
  for (const beat of sequence.beats) {
    if (!beat.camera) continue;
    add(sampleWith((sample) => sample.beatId === beat.id && sample.labels.includes("camera-hold")));
  }
  for (const sample of samples) add(sample);
  return [...selected.keys()].sort((left, right) => left - right);
}

export function assertVisualAuditBindings(
  report: VisualAuditReportV1,
  evidence: TemporalEvidenceV1,
  sequence: SequenceArtifactV1,
): void {
  if (report.evidenceArtifact !== "workflow/temporal-evidence.json") {
    throw new Error("Visual audit report references the wrong temporal evidence artifact");
  }
  if (report.verdict === "repair" && report.findings.length === 0) {
    throw new Error("Visual audit repair verdict requires at least one finding");
  }
  const frameIds = new Set(evidence.frames.map(({ id }) => id));
  const beatIds = new Set(sequence.beats.map(({ id }) => id));
  const entityIds = new Set(sequence.beats.flatMap((beat) => beat.entities.map(({ id }) => id)));
  for (const finding of report.findings) {
    if (finding.timeRange[1] > evidence.duration) {
      throw new Error(`Visual audit finding exceeds the film duration: ${finding.id}`);
    }
    for (const frameId of finding.frameIds) {
      if (!frameIds.has(frameId)) {
        throw new Error(`Visual audit finding references unknown frame ${frameId}`);
      }
    }
    for (const beatId of finding.beatIds) {
      if (!beatIds.has(beatId)) {
        throw new Error(`Visual audit finding references unknown beat ${beatId}`);
      }
    }
    for (const entityId of finding.entityIds) {
      if (!entityIds.has(entityId)) {
        throw new Error(`Visual audit finding references unknown entity ${entityId}`);
      }
    }
  }
}

function temporalSamples(
  sequence: SequenceArtifactV1,
  fps: number,
  duration: number,
): TemporalSample[] {
  const candidates: TemporalSample[] = [
    {
      at: 0,
      judgment: "landed",
      beatId: sequence.beats[0]?.id ?? null,
      transitionId: null,
      entityIds: sequence.beats[0]?.entities.map(({ id }) => id).slice(0, 20) ?? [],
      labels: ["opening-state"],
    },
    ...interactionTemporalSamples(sequence, fps, duration),
  ];
  const frameDuration = 1 / fps;
  for (const beat of sequence.beats) {
    const entityIds = beat.entities.map(({ id }) => id).slice(0, 20);
    for (const proofTime of beat.proofTimes) {
      candidates.push({
        at: proofTime,
        judgment: "landed",
        beatId: beat.id,
        transitionId: null,
        entityIds,
        labels: ["beat-proof"],
      });
    }
    if (beat.start !== undefined && beat.duration !== undefined) {
      const holdLead = Math.min(0.25, beat.duration / 4);
      candidates.push({
        at: Math.max(beat.start, beat.start + beat.duration - holdLead),
        judgment: "landed",
        beatId: beat.id,
        transitionId: null,
        entityIds,
        labels: ["beat-near-end-hold"],
      });
    }
    if (beat.camera) {
      const cameraTimes = [
        [beat.camera.arrival, "transit", "camera-arrival"],
        [beat.camera.settle, "landed", "camera-settle"],
        [beat.camera.hold, "landed", "camera-hold"],
      ] as const;
      for (const [at, judgment, label] of cameraTimes) {
        candidates.push({
          at,
          judgment,
          beatId: beat.id,
          transitionId: null,
          entityIds: [beat.camera.targetEntityId],
          labels: [label],
        });
      }
    }
  }
  for (const transition of sequence.transitions ?? []) {
    const entityIds = [transition.outgoingEntityId, transition.incomingEntityId].filter(
      (id): id is string => Boolean(id),
    );
    const transitionTimes = [
      [Math.max(0, transition.at - frameDuration), "transit", "transition-pre"],
      [transition.at + transition.duration / 2, "transit", "transition-mid"],
      [transition.at + transition.duration, "landed", "transition-landed"],
    ] as const;
    for (const [at, judgment, label] of transitionTimes) {
      candidates.push({
        at: Math.min(duration, at),
        judgment,
        beatId: label === "transition-landed" ? transition.toBeatId : transition.fromBeatId,
        transitionId: transition.id,
        entityIds,
        labels: [label],
      });
    }
  }
  const finalBeat = sequence.beats.at(-1);
  candidates.push({
    at: Math.max(0, duration - Math.max(0.25, frameDuration * 2)),
    judgment: "landed",
    beatId: finalBeat?.id ?? null,
    transitionId: null,
    entityIds: finalBeat?.entities.map(({ id }) => id).slice(0, 20) ?? [],
    labels: ["final-hold"],
  });
  return mergeTemporalSamples(candidates, duration);
}

function interactionTemporalSamples(
  sequence: SequenceArtifactV1,
  fps: number,
  duration: number,
): TemporalSample[] {
  const cues = sequence.audio?.cues ?? [];
  const frameDuration = 1 / fps;
  const phaseOffset = Math.max(POINTER_PHASE_OFFSET_SEC, frameDuration * 2);
  const samples: TemporalSample[] = [];

  for (const cue of cues) {
    const anchor = cue.kind === "typing" ? cue.startSec : cue.atSec;
    const owner = beatAtTime(sequence, anchor, duration);
    const bounds = interactionBounds(owner, duration);
    const entityIds = owner?.entities.map(({ id }) => id).slice(0, 20) ?? [];
    const common = {
      beatId: owner?.id ?? null,
      transitionId: null,
      entityIds,
    };

    if (cue.kind === "typing") {
      const start = clampTime(cue.startSec, bounds.start, bounds.end);
      const end = clampTime(cue.endSec, start, bounds.end);
      const midpoint = start + (end - start) / 2;
      samples.push(
        { ...common, at: start, judgment: "transit", labels: ["typing-start"] },
        { ...common, at: midpoint, judgment: "transit", labels: ["typing-mid"] },
        { ...common, at: end, judgment: "landed", labels: ["typing-end"] },
      );
      continue;
    }
    if (cue.kind !== "mouse-click") continue;

    samples.push(
      {
        ...common,
        at: clampTime(cue.atSec - phaseOffset, bounds.start, bounds.end),
        judgment: "transit",
        labels: ["pointer-approach"],
      },
      {
        ...common,
        at: clampTime(cue.atSec, bounds.start, bounds.end),
        judgment: "transit",
        labels: ["pointer-contact"],
      },
      {
        ...common,
        at: clampTime(cue.atSec + phaseOffset, bounds.start, bounds.end),
        judgment: "landed",
        labels: ["pointer-consequence"],
      },
    );
  }
  return samples;
}

function beatAtTime(
  sequence: SequenceArtifactV1,
  at: number,
  duration: number,
): SequenceArtifactV1["beats"][number] | null {
  const boundedAt = clampTime(at, 0, duration);
  const timedBeats = sequence.beats.filter(
    (beat): beat is SequenceArtifactV1["beats"][number] & { start: number; duration: number } =>
      beat.start !== undefined && beat.duration !== undefined,
  );
  const exact = timedBeats.find((beat) => {
    const end = Math.min(duration, beat.start + beat.duration);
    return boundedAt >= beat.start && (boundedAt < end || (end === duration && boundedAt <= end));
  });
  if (exact) return exact;

  return (
    timedBeats
      .map((beat) => ({
        beat,
        distance: Math.min(
          Math.abs(boundedAt - beat.start),
          Math.abs(boundedAt - Math.min(duration, beat.start + beat.duration)),
        ),
      }))
      .sort(
        (left, right) => left.distance - right.distance || left.beat.start - right.beat.start,
      )[0]?.beat ?? null
  );
}

function interactionBounds(
  beat: SequenceArtifactV1["beats"][number] | null,
  duration: number,
): { start: number; end: number } {
  const start = clampTime(beat?.start ?? 0, 0, duration);
  const beatEnd = beat?.duration === undefined ? duration : start + beat.duration;
  const boundedEnd = clampTime(beatEnd, start, duration);
  // Snapshot timestamps are rounded to milliseconds. Keep the upper bound on
  // the final renderable side of a beat/composition boundary.
  const end = Math.max(start, roundedTime(boundedEnd - 0.001));
  return { start, end };
}

function clampTime(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function mergeTemporalSamples(
  candidates: readonly TemporalSample[],
  duration: number,
): TemporalSample[] {
  const byTime = new Map<number, TemporalSample>();
  for (const candidate of candidates) {
    const at = roundedTime(Math.max(0, Math.min(duration, candidate.at)));
    const prior = byTime.get(at);
    if (!prior) {
      byTime.set(at, { ...candidate, at });
      continue;
    }
    byTime.set(at, {
      at,
      judgment:
        prior.judgment === "landed" || candidate.judgment === "landed" ? "landed" : "transit",
      beatId: prior.beatId ?? candidate.beatId,
      transitionId: prior.transitionId ?? candidate.transitionId,
      entityIds: [...new Set([...prior.entityIds, ...candidate.entityIds])].slice(0, 20),
      labels: [...new Set([...prior.labels, ...candidate.labels])].slice(0, 20),
    });
  }
  return [...byTime.values()].sort(
    (left, right) => left.at - right.at || left.labels.join().localeCompare(right.labels.join()),
  );
}

async function evidenceImageDigests(
  runRoot: string,
  evidenceImages: readonly string[],
): Promise<EvidenceImage[]> {
  const digests = await captureArtifactDigests(runRoot, evidenceImages);
  return digests.map((digest) => ({
    artifact: digest.path,
    sha256: digest.sha256,
    at: evidenceTime(digest.path),
  }));
}

function assignEvidenceImages(
  samples: readonly TemporalSample[],
  images: readonly EvidenceImage[],
  tolerance: number,
): Array<{ sample: TemporalSample; image: EvidenceImage }> {
  const unusedSamples = new Set(samples.map((_, index) => index));
  const assignments: Array<{ sample: TemporalSample; image: EvidenceImage }> = [];
  const orderedImages = images
    .filter((image): image is EvidenceImage & { at: number } => image.at !== null)
    .sort((left, right) => left.at - right.at);
  for (const image of orderedImages) {
    if (unusedSamples.size === 0 || assignments.length >= 40) break;
    const sampleIndex = [...unusedSamples]
      .filter((index) => Math.abs(samples[index]!.at - image.at) <= tolerance)
      .sort((left, right) => {
        const distance =
          Math.abs(samples[left]!.at - image.at) - Math.abs(samples[right]!.at - image.at);
        if (distance !== 0) return distance;
        return samples[left]!.at - samples[right]!.at;
      })[0];
    if (sampleIndex === undefined) continue;
    unusedSamples.delete(sampleIndex);
    assignments.push({ sample: samples[sampleIndex]!, image });
  }
  return assignments;
}

function evidenceTime(path: string): number | null {
  const match = /-at-(\d+(?:\.\d+)?)s(?=\.|$)/i.exec(path);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function roundedTime(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
