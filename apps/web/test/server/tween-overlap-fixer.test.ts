import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { QaReceiptV1 } from "../../src/shared";
import {
  TweenOverlapFixer,
  addOverwriteToLaterTween,
} from "../../src/server/qa-fixers/tween-overlap";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Specimen from run_34c0fb68: the press/release pair whose boundary instant
// the pinned lint reports as an overlap. Adding overwrite:"auto" to the later
// tween was empirically verified to silence the finding without changing any
// authored timing.
const SPECIMEN = `
  <script>
    productTimeline.to("#seq-chip-build", { backgroundColor: "#dff1ae", color: "#395c16", duration: 0.28 }, 10.18);
    productTimeline.to("#seq-chip-build", { scale: 1.08, duration: 0.16, ease: "back.out(1.6)" }, 10.46);
    productTimeline.to("#seq-chip-build", { scale: 1, duration: 0.18 }, 10.62);
  </script>
`;

describe("tween overlap fixer", () => {
  it("adds overwrite:auto to the later tween of the reported pair only", () => {
    const updated = addOverwriteToLaterTween(SPECIMEN, {
      selector: "#seq-chip-build",
      property: "scale",
      overlapStart: 10.62,
      sourceFiles: [],
    });

    expect(updated).toContain('{ overwrite: "auto", scale: 1, duration: 0.18 }, 10.62');
    expect(updated).toContain('{ scale: 1.08, duration: 0.16, ease: "back.out(1.6)" }, 10.46');
    expect(updated).not.toContain('overwrite: "auto", scale: 1.08');
  });

  it("targets the destination vars of a fromTo call", () => {
    const source = `tl.fromTo("#pointer", { x: 150, y: 210 }, { x: 0, y: 0, duration: 0.7 }, 8.12);`;
    const updated = addOverwriteToLaterTween(source, {
      selector: "#pointer",
      property: "x",
      overlapStart: 8.12,
      sourceFiles: [],
    });

    expect(updated).toContain('{ x: 150, y: 210 }, { overwrite: "auto", x: 0, y: 0, duration: 0.7 }, 8.12');
  });

  it("skips rather than guesses when no tween starts at the overlap instant", () => {
    expect(
      addOverwriteToLaterTween(SPECIMEN, {
        selector: "#seq-chip-build",
        property: "scale",
        overlapStart: 12.5,
        sourceFiles: [],
      }),
    ).toBeNull();
    expect(
      addOverwriteToLaterTween(SPECIMEN, {
        selector: "#unknown",
        property: "scale",
        overlapStart: 10.62,
        sourceFiles: [],
      }),
    ).toBeNull();
  });

  it("repairs a candidate from the QA finding and restores it transactionally", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-tween-overlap-"));
    roots.push(root);
    await writeFile(join(root, "index.html"), "<main></main>", "utf8");
    await mkdir(join(root, "compositions"), { recursive: true });
    const file = join(root, "compositions", "02-compose.html");
    await writeFile(file, SPECIMEN, "utf8");

    const qa: QaReceiptV1 = {
      version: "sequences.qa-receipt.v1",
      hyperframesVersion: "0.7.56",
      ok: false,
      commands: [
        { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
        { command: "check", ok: false, exitCode: 1, durationMs: 1, artifact: "check.json" },
      ],
      summary: { errorCount: 0, warningCount: 2, infoCount: 0 },
      findings: [
        {
          command: "lint",
          category: "lint",
          code: "overlapping_gsap_tweens",
          severity: "warning",
          sourceFile: null,
          selector: "#seq-chip-build",
          times: [],
          message: 'GSAP tweens overlap on "#seq-chip-build" for scale between 10.62s and 10.62s.',
          fixHint: 'Shorten the earlier tween, move the later tween, or add `overwrite: "auto"`.',
          artifact: "lint.json",
        },
        {
          command: "check",
          category: "lint",
          code: "overlapping_gsap_tweens",
          severity: "warning",
          sourceFile: "compositions/02-compose.html",
          selector: "#seq-chip-build",
          times: [0],
          message: 'GSAP tweens overlap on "#seq-chip-build" for scale between 10.62s and 10.62s.',
          fixHint: 'Shorten the earlier tween, move the later tween, or add `overwrite: "auto"`.',
          artifact: "check.json",
        },
      ],
    };

    const fixer = new TweenOverlapFixer();
    const result = await fixer.apply(root, qa, ["compositions/**", "index.html"]);

    // The duplicated lint/check findings collapse to one repair.
    expect(result.repaired).toEqual([
      {
        sourceFile: "compositions/02-compose.html",
        selector: "#seq-chip-build",
        property: "scale",
        at: 10.62,
      },
    ]);
    expect(await readFile(file, "utf8")).toContain('{ overwrite: "auto", scale: 1, duration: 0.18 }');

    await result.restore();
    expect(await readFile(file, "utf8")).toBe(SPECIMEN);
  });
});
