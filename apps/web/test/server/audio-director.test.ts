import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SequenceArtifactV1Schema, type SequenceArtifactV1 } from "../../src/shared";
import { AudioDirector } from "../../src/server/audio-director";

// The vendored catalog is repository truth; these tests run against the real
// committed bytes so a stale hash or missing bed fails here before a probe.
const workspaceRoot = resolve(import.meta.dirname, "..", "..", "..", "..");

function sequenceWith(audio: unknown, targetDuration = 24): SequenceArtifactV1 {
  return SequenceArtifactV1Schema.parse({
    version: "sequences.sequence.v1",
    format: { width: 1920, height: 1080, fps: 30, targetDuration },
    concept: { summary: "Launch", hierarchy: ["one"], motionGrammar: ["push"] },
    beats: [
      {
        id: "hook",
        role: "hook",
        start: 0,
        duration: targetDuration,
        purpose: "Open",
        proofTimes: [1],
        implementationFiles: ["compositions/02-compose.html"],
      },
    ],
    transitions: [],
    overlapIntents: [],
    audio,
    revision: null,
  });
}

describe("audio direction contract", () => {
  it("parses a typed audio plan inside sequence.json and treats null as absent", () => {
    const sequence = sequenceWith({
      soundtrackId: "confident-commercial",
      cues: [
        { kind: "typing", startSec: 7.5, endSec: 8.7 },
        { kind: "mouse-click", atSec: 9.4 },
        { kind: "woosh", atSec: 5.4 },
      ],
    });
    expect(sequence.audio?.soundtrackId).toBe("confident-commercial");
    expect(sequence.audio?.cues).toHaveLength(3);
    expect(sequenceWith(null).audio).toBeUndefined();
  });
});

describe("audio director", () => {
  const director = new AudioDirector(workspaceRoot);

  it("loads the committed catalog with every SFX kind and beat analysis", async () => {
    const catalog = await director.load();
    expect(catalog.soundtracks.length).toBeGreaterThanOrEqual(12);
    expect(new Set(catalog.sfx.map((entry) => entry.kind))).toEqual(
      new Set(["typing", "mouse-click", "pop", "woosh", "notification"]),
    );
    for (const bed of catalog.soundtracks) {
      expect(bed.analysis.bpm).toBeGreaterThan(0);
      expect(bed.analysis.barSec).toBeGreaterThan(0);
      expect(bed.durationSec).toBeGreaterThanOrEqual(30);
    }
  });

  it("verifies the vendored bytes against the committed hashes", async () => {
    await expect(director.verifySources()).resolves.toBeUndefined();
  });

  it("accepts a valid plan and an absent plan", async () => {
    await expect(
      director.assertAudioDirection(
        sequenceWith({
          soundtrackId: "fast-pop",
          cues: [
            { kind: "typing", startSec: 2, endSec: 6 },
            { kind: "pop", atSec: 12 },
            { kind: "notification", atSec: 20 },
          ],
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(director.assertAudioDirection(sequenceWith(null))).resolves.toBeUndefined();
  });

  it("rejects an unknown soundtrack, out-of-film cues, oversized typing windows, and duplicates", async () => {
    await expect(
      director.assertAudioDirection(sequenceWith({ soundtrackId: "invented-bed", cues: [] })),
    ).rejects.toThrow(/soundtrackId is not in the host catalog/);
    await expect(
      director.assertAudioDirection(
        sequenceWith({ soundtrackId: "fast-pop", cues: [{ kind: "pop", atSec: 25 }] }),
      ),
    ).rejects.toThrow(/outside the film/);
    await expect(
      director.assertAudioDirection(
        sequenceWith({
          soundtrackId: "fast-pop",
          cues: [{ kind: "typing", startSec: 1, endSec: 10.5 }],
        }),
      ),
    ).rejects.toThrow(/bounded window/);
    await expect(
      director.assertAudioDirection(
        sequenceWith({
          soundtrackId: "fast-pop",
          cues: [
            { kind: "mouse-click", atSec: 9.4 },
            { kind: "mouse-click", atSec: 9.4 },
          ],
        }),
      ),
    ).rejects.toThrow(/duplicates/);
  });

  it("rejects a per-kind cue budget violation", async () => {
    await expect(
      director.assertAudioDirection(
        sequenceWith({
          soundtrackId: "fast-pop",
          cues: Array.from({ length: 7 }, (_value, index) => ({
            kind: "pop",
            atSec: index + 1,
          })),
        }),
      ),
    ).rejects.toThrow(/pop cue budget/);
  });

  it("exposes a compact author catalog with bar grids and coarse energy", async () => {
    const catalog = (await director.authorCatalog()) as {
      soundtracks: Array<Record<string, unknown>>;
      sfx: Array<Record<string, unknown>>;
    };
    expect(catalog.soundtracks.length).toBeGreaterThanOrEqual(12);
    for (const bed of catalog.soundtracks) {
      expect(bed).toHaveProperty("barSec");
      expect(bed).toHaveProperty("beatConfidence");
      expect((bed.openingEnergy as number[]).length).toBeLessThanOrEqual(3);
      expect(bed).not.toHaveProperty("file");
      expect(bed).not.toHaveProperty("sha256");
      expect(bed).not.toHaveProperty("gainDb");
    }
    const serialized = JSON.stringify(catalog);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8 * 1_024);
  });

  it("builds the host-owned mix plan and never for a silent film", async () => {
    await expect(
      director.mixPlan({
        videoPath: "C:/video.mp4",
        outputPath: "C:/out.mp4",
        sequence: sequenceWith(null),
      }),
    ).resolves.toBeNull();

    const plan = await director.mixPlan({
      videoPath: "C:/video.mp4",
      outputPath: "C:/out.mp4",
      sequence: sequenceWith({
        soundtrackId: "confident-commercial",
        cues: [
          { kind: "typing", startSec: 7.5, endSec: 8.7 },
          { kind: "mouse-click", atSec: 9.4 },
        ],
      }),
    });
    expect(plan).not.toBeNull();
    expect(plan!.soundtrackId).toBe("confident-commercial");
    expect(plan!.cueCount).toBe(2);
    const args = plan!.args;
    // Bed loops, both cues are delayed into place, one amix owns the output.
    expect(args.join(" ")).toContain("-stream_loop -1");
    expect(args.some((argument) => argument.endsWith("confident_commercial.mp3"))).toBe(true);
    const filterGraph = args[args.indexOf("-filter_complex") + 1]!;
    expect(filterGraph).toContain("adelay=7500:all=1");
    expect(filterGraph).toContain("adelay=9400:all=1");
    expect(filterGraph).toContain("amix=inputs=3");
    expect(filterGraph).toContain("alimiter=limit=0.95");
    expect(args.at(-1)).toBe("C:/out.mp4");
    expect(args).toContain("copy");
    expect(args).toContain("aac");
  });

  it("refuses to plan a mix for an invalid declaration", async () => {
    await expect(
      director.mixPlan({
        videoPath: "C:/video.mp4",
        outputPath: "C:/out.mp4",
        sequence: sequenceWith({ soundtrackId: "invented-bed", cues: [] }),
      }),
    ).rejects.toThrow(/soundtrackId/);
  });
});
