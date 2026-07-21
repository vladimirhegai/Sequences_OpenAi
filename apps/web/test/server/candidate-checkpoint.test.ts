import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureCandidateCheckpoint } from "../../src/server/candidate-checkpoint";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("candidate repair checkpoint", () => {
  it("reports and restores modified, deleted, and added creative files", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-repair-checkpoint-"));
    roots.push(root);
    await mkdir(join(root, "compositions"));
    await mkdir(join(root, ".agents"));
    await writeFile(join(root, "index.html"), "before", "utf8");
    await writeFile(join(root, "compositions", "scene.html"), "scene", "utf8");
    await writeFile(join(root, ".agents", "manifest.json"), "protected", "utf8");
    const checkpoint = await captureCandidateCheckpoint(root);

    await writeFile(join(root, "index.html"), "after", "utf8");
    await rm(join(root, "compositions", "scene.html"));
    await writeFile(join(root, "sequence.json"), "{}", "utf8");
    await writeFile(join(root, ".agents", "manifest.json"), "ignored-change", "utf8");

    expect(await checkpoint.changedPaths()).toEqual([
      "compositions/scene.html",
      "index.html",
      "sequence.json",
    ]);
    await checkpoint.restore();
    expect(await readFile(join(root, "index.html"), "utf8")).toBe("before");
    expect(await readFile(join(root, "compositions", "scene.html"), "utf8")).toBe("scene");
    await expect(readFile(join(root, "sequence.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, ".agents", "manifest.json"), "utf8")).toBe("ignored-change");
  });

  it("restores selected paths while preserving other edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-partial-checkpoint-"));
    roots.push(root);
    await writeFile(join(root, "locked.json"), "before", "utf8");
    await writeFile(join(root, "composition.html"), "before", "utf8");
    const checkpoint = await captureCandidateCheckpoint(root);

    await writeFile(join(root, "locked.json"), "changed", "utf8");
    await writeFile(join(root, "composition.html"), "changed", "utf8");
    await writeFile(join(root, "new-locked.json"), "added", "utf8");
    await checkpoint.restorePaths(["locked.json", "new-locked.json"]);

    expect(await readFile(join(root, "locked.json"), "utf8")).toBe("before");
    expect(await readFile(join(root, "composition.html"), "utf8")).toBe("changed");
    await expect(readFile(join(root, "new-locked.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await checkpoint.changedPaths()).toEqual(["composition.html"]);
  });
});
