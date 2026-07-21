import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SequenceArtifactV1Schema } from "../../src/shared";
import { assertComponentPlan } from "../../src/server/component-plan";
import { createServerConfig } from "../../src/server/config";
import { ApiProblem } from "../../src/server/errors";
import {
  inspectImageInput,
  MAX_IMAGE_INPUT_BYTES,
  readBoundedImageBody,
} from "../../src/server/image-input";
import { ProjectStore } from "../../src/server/project-store";
import { authorFreshBuildFixture } from "./fresh-build-fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe("trusted image intake", () => {
  it.each([
    ["PNG", png(640, 360), "image/png", { extension: "png", width: 640, height: 360 }],
    ["JPEG", jpeg(1_280, 720), "image/jpeg", { extension: "jpg", width: 1_280, height: 720 }],
    ["WebP", webp(1_920, 1_080), "image/webp", { extension: "webp", width: 1_920, height: 1_080 }],
  ])("recognizes a supported %s header and its dimensions", (_name, bytes, mediaType, expected) => {
    expect(inspectImageInput(bytes, `${mediaType}; charset=binary`)).toEqual({
      ...expected,
      mediaType,
    });
  });

  it("rejects a declared MIME type that disagrees with the bytes", () => {
    expectApiProblem(() => inspectImageInput(png(320, 180), "image/jpeg"), {
      status: 422,
      code: "image_type_mismatch",
    });
  });

  it("rejects truncated, zero-sized, and oversized image headers", () => {
    expectApiProblem(() => inspectImageInput(png(100, 100).subarray(0, 12), "image/png"), {
      status: 422,
      code: "unsupported_image_input",
    });
    expectApiProblem(() => inspectImageInput(png(0, 100), "image/png"), {
      status: 422,
      code: "unsupported_image_input",
    });
    expectApiProblem(() => inspectImageInput(png(16_385, 100), "image/png"), {
      status: 422,
      code: "image_dimensions_too_large",
    });
    expectApiProblem(() => inspectImageInput(png(16_384, 16_384), "image/png"), {
      status: 422,
      code: "image_dimensions_too_large",
    });
  });

  it("accepts an exact 15 MiB streamed body and rejects the next byte", async () => {
    const chunk = new Uint8Array(1_024 * 1_024);
    const exact = await readBoundedImageBody(streamingRequest(chunk, 15));
    expect(exact.byteLength).toBe(MAX_IMAGE_INPUT_BYTES);

    await expect(readBoundedImageBody(streamingRequest(chunk, 16))).rejects.toMatchObject({
      status: 413,
      code: "image_input_too_large",
    });
    await expect(
      readBoundedImageBody(
        new Request("http://127.0.0.1/images", {
          method: "POST",
          headers: { "content-length": String(MAX_IMAGE_INPUT_BYTES + 1) },
        }),
      ),
    ).rejects.toMatchObject({ status: 413, code: "image_input_too_large" });
  });

  it("stores trusted metadata, copies the bytes into a fresh candidate, and detects mutation", async () => {
    const workspace = process.cwd();
    const root = await mkdtemp(join(tmpdir(), "sequences-image-input-"));
    roots.push(root);
    const config = createServerConfig({
      workspaceRoot: workspace,
      acceptedRoot: join(root, "accepted"),
      seedRoot: join(workspace, "fixtures", "release-a"),
      shellRoot: join(workspace, "fixtures", "saas-shell"),
      candidatesRoot: join(root, "candidates"),
      runsRoot: join(root, "runs"),
      rendersRoot: join(root, "renders"),
      renderWorktreesRoot: join(root, "render-worktrees"),
      imageInputsRoot: join(root, "image-inputs"),
    });
    const projects = new ProjectStore(config);
    await projects.initialize();

    const original = png(1_440, 900);
    const staged = await projects.storeImageInput(original, "image/png");
    expect(staged).toMatchObject({
      mediaType: "image/png",
      bytes: original.byteLength,
      width: 1_440,
      height: 900,
    });
    expect(staged.path).toMatch(/^assets\/derived\/input-[0-9a-f]{32}\.png$/);
    expect(await projects.readImageInput(staged.path)).toEqual(staged);

    const jobId = "run_10000000000040008000000000000001";
    let candidateCreated = false;
    try {
      const fresh = await projects.createFreshCandidate(jobId, await projects.acceptedCommit(), [
        staged.path,
      ]);
      candidateCreated = true;
      const candidateImagePath = join(fresh.candidate, ...staged.path.split("/"));
      expect(new Uint8Array(await readFile(candidateImagePath))).toEqual(original);

      await authorFreshBuildFixture(fresh.candidate);
      const planPath = join(fresh.candidate, "story", "component-plan.json");
      const plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
      plan.mode = "reference-derived";
      plan.sourceImages = [staged.path];
      plan.sourceImageBindings = [
        {
          imagePath: staged.path,
          beatIds: ["product-proof"],
          narrativeRole: "proof",
          purpose: "Land on the supplied product state as the action's visible consequence.",
        },
      ];
      plan.sourceEvidence = "The supplied screenshot establishes the product surface geometry.";
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      const sequence = SequenceArtifactV1Schema.parse(
        JSON.parse(await readFile(join(fresh.candidate, "sequence.json"), "utf8")) as unknown,
      );

      await expect(assertComponentPlan(fresh.candidate, sequence, [staged])).rejects.toThrow(
        `must bind every supplied reference to a code-native recreated state`,
      );
      const compositionPath = join(fresh.candidate, "compositions", "02-compose.html");
      const composition = await readFile(compositionPath, "utf8");
      await writeFile(
        compositionPath,
        composition.replace(
          "</template>",
          `<img src="${staged.path}" data-reference-image="${staged.path}" data-reference-beats="product-proof" alt="Product reference" />\n</template>`,
        ),
        "utf8",
      );
      await expect(assertComponentPlan(fresh.candidate, sequence, [staged])).rejects.toThrow(
        `host screenshots are reference-only and cannot be rendered as image planes`,
      );
      await writeFile(
        compositionPath,
        composition.replace(
          "</template>",
          `<section data-reference-image="${staged.path}" data-reference-mode="recreated" data-reference-beats="product-proof">Code-native product recreation</section>\n</template>`,
        ),
        "utf8",
      );

      await expect(assertComponentPlan(fresh.candidate, sequence, [staged])).resolves.toMatchObject(
        {
          mode: "reference-derived",
          sourceImages: [staged.path],
        },
      );

      await writeFile(candidateImagePath, png(1_439, 900));
      await expect(assertComponentPlan(fresh.candidate, sequence, [staged])).rejects.toThrow(
        `source image was modified after trusted intake: ${staged.path}`,
      );
    } finally {
      if (candidateCreated) await projects.removeCandidate(jobId).catch(() => undefined);
    }
  }, 60_000);
});

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  bytes[7] = (height >>> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >>> 8) & 0xff;
  bytes[10] = width & 0xff;
  bytes[11] = 3;
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  setUint24(bytes, 24, width - 1);
  setUint24(bytes, 27, height - 1);
  return bytes;
}

function setUint24(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function streamingRequest(chunk: Uint8Array, count: number): Request {
  let emitted = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted < count) {
        controller.enqueue(chunk);
        emitted += 1;
      } else {
        controller.close();
      }
    },
  });
  return new Request("http://127.0.0.1/images", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
}

function expectApiProblem(
  operation: () => unknown,
  expected: Pick<ApiProblem, "status" | "code">,
): void {
  try {
    operation();
    throw new Error("Expected image inspection to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiProblem);
    expect(error).toMatchObject(expected);
  }
}
