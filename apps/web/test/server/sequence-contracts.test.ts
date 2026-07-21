import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SequenceArtifactV1Schema,
  type SequenceArtifactV1,
} from "../../src/shared/sequence-contracts";
import {
  assertLaunchMotionSidecar,
  assertLaunchSequenceSemantics,
  normalizeDomCameraOwners,
  normalizeLaunchMotionSidecarTargets,
  normalizeNumericMusicAnchors,
  type MotionSelectorMissingNormalization,
} from "../../src/server/sequence-artifact";

describe("Sequences SaaS motion semantics", () => {
  it("normalizes semantic DOM camera IDs to the runtime owner enum", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-camera-owner-"));
    const sequence = validSequence();
    (sequence.beats[1]!.camera! as unknown as { owner: string }).owner = "relay-product-world";
    try {
      await writeFile(join(root, "sequence.json"), JSON.stringify(sequence), "utf8");
      expect(await normalizeDomCameraOwners(root)).toBe(1);
      const normalized = JSON.parse(
        await readFile(join(root, "sequence.json"), "utf8"),
      ) as SequenceArtifactV1;
      expect(normalized.beats[1]!.camera!.owner).toBe("dom-world");
      expect(SequenceArtifactV1Schema.safeParse(normalized).success).toBe(true);
      expect(await normalizeDomCameraOwners(root)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves numeric music timing intent as contract-valid labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-music-anchor-"));
    const sequence = validSequence();
    (sequence.beats[0]! as unknown as { musicAnchors: unknown[] }).musicAnchors = [0.023, 4.0168];
    try {
      await writeFile(join(root, "sequence.json"), JSON.stringify(sequence), "utf8");
      expect(await normalizeNumericMusicAnchors(root)).toBe(2);
      const normalized = JSON.parse(
        await readFile(join(root, "sequence.json"), "utf8"),
      ) as SequenceArtifactV1;
      expect(normalized.beats[0]!.musicAnchors).toEqual(["at-0.023s", "at-4.0168s"]);
      expect(SequenceArtifactV1Schema.safeParse(normalized).success).toBe(true);
      expect(await normalizeNumericMusicAnchors(root)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts adjacent transition and camera intent with fixed timing", () => {
    const sequence = SequenceArtifactV1Schema.parse(validSequence());

    expect(() => assertLaunchSequenceSemantics(sequence)).not.toThrow();
    expect(sequence.beats[1]?.camera?.targetEntityId).toBe("product-card");
    expect(sequence.transitions?.[0]?.kind).toBe("match-cut");
  });

  it("normalizes the common 2D camera rotation alias to rotationZ", () => {
    const source = validSequence();
    Object.assign(source.beats[1]!.camera!.startPose, { rotation: -1.5 });
    Object.assign(source.beats[1]!.camera!.endPose, { rotation: 2.25 });

    const sequence = SequenceArtifactV1Schema.parse(source);

    expect(sequence.beats[1]!.camera!.startPose.rotationZ).toBe(-1.5);
    expect(sequence.beats[1]!.camera!.endPose.rotationZ).toBe(2.25);
    expect(sequence.beats[1]!.camera!.startPose).not.toHaveProperty("rotation");
  });

  it("rejects identity transitions without both semantic anchors", () => {
    const sequence = validSequence();
    const transition = sequence.transitions[0]!;
    sequence.transitions[0] = {
      ...transition,
      incomingEntityId: undefined,
    };

    expect(SequenceArtifactV1Schema.safeParse(sequence).success).toBe(false);
  });

  it("reports transition-local semantics alongside an unrelated invalid beat field", () => {
    const sequence = validSequence() as unknown as SequenceArtifactV1;
    sequence.beats[0]!.sourceIds = ["assets/reference.png"];
    sequence.transitions![0] = {
      ...sequence.transitions![0]!,
      kind: "morph",
      duration: 0,
    };

    const result = SequenceArtifactV1Schema.safeParse(sequence);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["beats", 0, "sourceIds", 0] }),
        expect.objectContaining({
          path: ["transitions", 0, "duration"],
          message: "Only a cut or match-cut can have zero duration",
        }),
      ]),
    );
  });

  it("accepts an instantaneous identity-preserving match cut", () => {
    const sequence = validSequence();
    sequence.transitions[0] = { ...sequence.transitions[0]!, duration: 0 };

    expect(SequenceArtifactV1Schema.safeParse(sequence).success).toBe(true);
  });

  it("treats explicit null as absent on optional authored fields", () => {
    // The author contract teaches null-for-absent ("camera": null), so a
    // director writing null on an unused optional field is not a semantic
    // failure. A live Luna probe failed the whole run on exactly this.
    const source = validSequence();
    source.transitions[0] = {
      ...source.transitions[0]!,
      kind: "cut",
      duration: 0,
      outgoingEntityId: null,
      incomingEntityId: null,
    } as unknown as (typeof source.transitions)[number];
    Object.assign(source.beats[0]!, { camera: null });

    const sequence = SequenceArtifactV1Schema.parse(source);

    expect(sequence.transitions?.[0]?.outgoingEntityId).toBeUndefined();
    expect(sequence.transitions?.[0]?.incomingEntityId).toBeUndefined();
    expect(sequence.beats[0]?.camera).toBeUndefined();

    // Null is still not a free pass where the semantics require the field.
    const identity = validSequence();
    identity.transitions[0] = {
      ...identity.transitions[0]!,
      outgoingEntityId: null,
    } as unknown as (typeof identity.transitions)[number];
    expect(SequenceArtifactV1Schema.safeParse(identity).success).toBe(false);

    // Rationale is documentation, not validity: omitting it on a plain cut
    // must not fail the artifact (a live probe died on exactly this).
    const undocumented = validSequence();
    const { rationale: _rationale, ...bare } = undocumented.transitions[0]!;
    undocumented.transitions[0] = {
      ...bare,
      kind: "cut",
      duration: 0,
    } as unknown as (typeof undocumented.transitions)[number];
    expect(SequenceArtifactV1Schema.safeParse(undocumented).success).toBe(true);
  });

  it("requires every launch beat boundary to declare an intentional handoff", () => {
    const sequence = SequenceArtifactV1Schema.parse({ ...validSequence(), transitions: [] });

    expect(() => assertLaunchSequenceSemantics(sequence)).toThrow(
      "one intentional transition for every beat boundary",
    );
  });

  it("reports independent launch-timing mismatches in one packet", () => {
    const sequence = SequenceArtifactV1Schema.parse(validSequence());
    sequence.beats[0]!.proofTimes = [4];
    sequence.beats[1]!.camera!.arrival = 2;
    sequence.transitions![0]!.at = 4;
    sequence.format!.targetDuration = 9;

    expect(() => assertLaunchSequenceSemantics(sequence)).toThrow(
      /found 4 mismatches:[\s\S]*proof time for hook falls outside its beat[\s\S]*camera timing for product-proof falls outside its beat[\s\S]*transition hook-to-proof must align with the product-proof boundary[\s\S]*beat timing must end at format.targetDuration/,
    );
  });

  it("accepts only the exact HyperFrames motion-sidecar assertion grammar", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-motion-contract-"));
    const sequence = SequenceArtifactV1Schema.parse(validSequence());
    try {
      await writeFile(
        join(root, "index.motion.json"),
        JSON.stringify({
          version: 1,
          duration: 8,
          assertions: [
            { kind: "appearsBy", selector: "#hook", bySec: 1 },
            { kind: "staysInFrame", selector: "#product-world" },
          ],
        }),
      );
      await expect(assertLaunchMotionSidecar(root, sequence)).resolves.toBeUndefined();

      await writeFile(
        join(root, "index.motion.json"),
        JSON.stringify({
          version: "sequences.motion.v1",
          duration: 8,
          assertions: [{ kind: "primary", selector: "#hook", property: "opacity" }],
        }),
      );
      await expect(assertLaunchMotionSidecar(root, sequence)).rejects.toThrow(
        "index.motion.json is invalid",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports independent motion-evidence mismatches in one packet", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-motion-aggregate-"));
    const sequence = SequenceArtifactV1Schema.parse(validSequence());
    try {
      await writeFile(
        join(root, "index.motion.json"),
        JSON.stringify({
          version: 1,
          duration: 7,
          assertions: [{ kind: "appearsBy", selector: "#hook", bySec: 8 }],
        }),
      );

      await expect(assertLaunchMotionSidecar(root, sequence)).rejects.toThrow(
        /found 4 mismatches:[\s\S]*duration must match[\s\S]*at least one meaningful assertion per sequence beat[\s\S]*verify both a beat arrival and an in-frame product subject[\s\S]*appearsBy time exceeds the composition duration/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retargets whole-frame assertions to a repeated semantic product surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-motion-target-"));
    const source = validSequence();
    source.beats[0]!.entities.push({
      id: "product-surface",
      role: "Persistent product surface",
      parts: [],
    });
    source.beats[1]!.entities.push({
      id: "product-surface",
      role: "Persistent product surface",
      parts: [],
    });
    const sequence = SequenceArtifactV1Schema.parse(source);
    try {
      await writeFile(
        join(root, "index.html"),
        '<main id="product-world"><section data-hf-id="product-surface">UI</section></main>',
      );
      await writeFile(
        join(root, "index.motion.json"),
        JSON.stringify({
          version: 1,
          duration: 8,
          assertions: [
            { kind: "appearsBy", selector: "#product-surface", bySec: 1 },
            { kind: "staysInFrame", selector: "#product-world" },
          ],
        }),
      );

      await expect(normalizeLaunchMotionSidecarTargets(root, sequence)).resolves.toBe(
        '[data-hf-id="product-surface"]',
      );
      const motion = JSON.parse(await readFile(join(root, "index.motion.json"), "utf8"));
      expect(motion.assertions[1].selector).toBe('[data-hf-id="product-surface"]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops keepsMoving scopes the HyperFrames liveness sampler cannot measure", async () => {
    // Specimen from run_91327367: a rotating aria-hidden orbit carried the
    // liveness scope; the motion sampler never sees decorative nodes and the
    // run failed on that single finding.
    // Specimen from run_37e2e7a6: the sampler signs only descendants of the
    // scoped root, so a positive-size animated leaf caret also looks missing.
    const root = await mkdtemp(join(tmpdir(), "sequences-motion-decorative-"));
    const sequence = SequenceArtifactV1Schema.parse(validSequence());
    try {
      await writeFile(
        join(root, "index.html"),
        '<main id="product"><div id="ambient-orbit" aria-hidden="true"></div><i id="editor-caret" data-hf-id="editor-caret"></i><p id="copy">UI</p></main>',
      );
      await writeFile(
        join(root, "index.motion.json"),
        JSON.stringify({
          version: 1,
          duration: 8,
          assertions: [
            { kind: "appearsBy", selector: "#product", bySec: 1 },
            { kind: "staysInFrame", selector: "#product" },
            { kind: "keepsMoving", withinSelector: "#ambient-orbit", maxStaticSec: 2 },
            { kind: "keepsMoving", withinSelector: "#editor-caret", maxStaticSec: 3.8 },
            { kind: "keepsMoving", withinSelector: "#product", maxStaticSec: 4 },
          ],
        }),
      );

      await normalizeLaunchMotionSidecarTargets(root, sequence);

      const motion = JSON.parse(await readFile(join(root, "index.motion.json"), "utf8"));
      expect(motion.assertions[2]).toEqual({ kind: "keepsMoving", maxStaticSec: 2 });
      expect(motion.assertions[3]).toEqual({ kind: "keepsMoving", maxStaticSec: 3.8 });
      // A readable, findable scope is preserved.
      expect(motion.assertions[4]).toEqual({
        kind: "keepsMoving",
        withinSelector: "#product",
        maxStaticSec: 4,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops keepsMoving scopes whose initial CSS gives the target zero extent", async () => {
    // Specimen from run_72e34619: a progress fill existed in the mounted DOM,
    // but width:0% at time zero made both its id and data-hf-id selectors
    // unmeasurable to the liveness sampler.
    const root = await mkdtemp(join(tmpdir(), "sequences-motion-zero-extent-"));
    const sequence = SequenceArtifactV1Schema.parse(validSequence());
    try {
      await writeFile(
        join(root, "index.html"),
        [
          "<style>#progress-fill { width: 0%; height: 12px; }</style>",
          '<main id="product"><div id="progress-fill" data-hf-id="progress-fill"></div></main>',
        ].join("\n"),
      );
      await writeFile(
        join(root, "index.motion.json"),
        JSON.stringify({
          version: 1,
          duration: 8,
          assertions: [
            { kind: "appearsBy", selector: "#product", bySec: 1 },
            { kind: "staysInFrame", selector: "#product" },
            { kind: "keepsMoving", withinSelector: "#progress-fill", maxStaticSec: 3 },
            {
              kind: "keepsMoving",
              withinSelector: '[data-hf-id="progress-fill"]',
              maxStaticSec: 3,
            },
          ],
        }),
      );

      await normalizeLaunchMotionSidecarTargets(root, sequence);

      const motion = JSON.parse(await readFile(join(root, "index.motion.json"), "utf8"));
      expect(motion.assertions.slice(2)).toEqual([
        { kind: "keepsMoving", maxStaticSec: 3 },
        { kind: "keepsMoving", maxStaticSec: 3 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops a keepsMoving scope that targets an unmountable world wrapper", async () => {
    // Specimen from run_823d2a4f: keepsMoving scoped to the sub-composition
    // root #meridian-world, whose identity is consumed at template mount, so
    // the selector matched nothing in any sampled frame and QA hard-failed.
    const root = await mkdtemp(join(tmpdir(), "sequences-motion-keepsmoving-"));
    const sequence = SequenceArtifactV1Schema.parse(validSequence());
    try {
      await writeFile(join(root, "index.html"), '<main id="product"><p>UI</p></main>');
      await writeFile(
        join(root, "index.motion.json"),
        JSON.stringify({
          version: 1,
          duration: 8,
          assertions: [
            { kind: "appearsBy", selector: "#product", bySec: 1 },
            { kind: "staysInFrame", selector: "#product" },
            { kind: "keepsMoving", withinSelector: "#meridian-world", maxStaticSec: 3 },
          ],
        }),
      );

      await normalizeLaunchMotionSidecarTargets(root, sequence);

      const motion = JSON.parse(await readFile(join(root, "index.motion.json"), "utf8"));
      expect(motion.assertions[2]).toEqual({ kind: "keepsMoving", maxStaticSec: 3 });
      // Safe scopes are left alone.
      expect(motion.assertions[1].selector).toBe("#product");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retargets live identity assertions and drops a missing data-hf-id assertion", async () => {
    // Specimen from run_1915354a: the final wordmark exposed the semantic
    // identity as data-hf-id="trellis-wordmark" but its DOM id was
    // "final-wordmark", so #trellis-wordmark failed every sampled frame.
    const root = await mkdtemp(join(tmpdir(), "sequences-motion-hf-id-"));
    const sequence = SequenceArtifactV1Schema.parse(validSequence());
    try {
      await writeFile(
        join(root, "index.html"),
        '<main id="product"><div id="candidate" data-hf-id="candidate-card">Candidate</div><div id="final-wordmark" data-hf-id="trellis-wordmark">Trellis</div></main>',
      );
      await writeFile(
        join(root, "index.motion.json"),
        JSON.stringify({
          version: 1,
          duration: 8,
          assertions: [
            { kind: "appearsBy", selector: "#trellis-wordmark", bySec: 7 },
            { kind: "before", a: "#candidate-card", b: "#trellis-wordmark" },
            { kind: "staysInFrame", selector: "#candidate-card" },
            { kind: "appearsBy", selector: '[data-hf-id="removed-panel"]', bySec: 4 },
          ],
        }),
      );

      const dropped: MotionSelectorMissingNormalization[] = [];
      await normalizeLaunchMotionSidecarTargets(root, sequence, {
        onMotionSelectorMissing: (finding) => dropped.push(finding),
      });

      const motion = JSON.parse(await readFile(join(root, "index.motion.json"), "utf8"));
      expect(motion.assertions).toEqual([
        { kind: "appearsBy", selector: '[data-hf-id="trellis-wordmark"]', bySec: 7 },
        {
          kind: "before",
          a: '[data-hf-id="candidate-card"]',
          b: '[data-hf-id="trellis-wordmark"]',
        },
        { kind: "staysInFrame", selector: '[data-hf-id="candidate-card"]' },
      ]);
      expect(dropped).toEqual([
        {
          code: "motion_selector_missing",
          assertionKind: "appearsBy",
          selectors: ['[data-hf-id="removed-panel"]'],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function validSequence() {
  return {
    version: "sequences.sequence.v1" as const,
    format: { width: 1920, height: 1080, fps: 30, targetDuration: 8 },
    concept: {
      summary: "A product card resolves a noisy workflow.",
      hierarchy: ["Friction", "Product proof"],
      motionGrammar: ["compress", "match", "settle"],
      rejectedChoices: [],
    },
    beats: [
      {
        id: "hook",
        role: "hook" as const,
        start: 0,
        duration: 3,
        purpose: "Establish friction.",
        claims: [],
        entities: [{ id: "hook-card", role: "Unresolved product card", parts: [] }],
        sourceIds: [],
        musicAnchors: [],
        proofTimes: [1.5],
        implementationFiles: ["compositions/01-hook.html"],
        camera: null,
      },
      {
        id: "product-proof",
        role: "product-proof" as const,
        start: 3,
        duration: 5,
        purpose: "Show the product resolving the work.",
        claims: [],
        entities: [{ id: "product-card", role: "Resolved product card", parts: [] }],
        sourceIds: [],
        musicAnchors: [],
        proofTimes: [6],
        implementationFiles: ["compositions/02-proof.html"],
        camera: {
          owner: "dom-world" as const,
          targetEntityId: "product-card",
          startPose: { x: 0, y: 0, scale: 1 },
          endPose: { x: -180, y: 0, scale: 1.4 },
          arrival: 4,
          settle: 4.6,
          hold: 7.5,
        },
      },
    ],
    transitions: [
      {
        id: "hook-to-proof",
        fromBeatId: "hook",
        toBeatId: "product-proof",
        kind: "match-cut" as const,
        at: 3,
        duration: 0.4,
        outgoingEntityId: "hook-card",
        incomingEntityId: "product-card" as string | undefined,
        rationale: "Carry the card identity through the story turn.",
      },
    ],
    overlapIntents: [],
    revision: null,
  };
}
