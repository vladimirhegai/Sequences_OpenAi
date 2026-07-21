import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { QaReceiptV1 } from "../../src/shared";
import {
  ContrastFixer,
  accessibleBrandColor,
  contrastRatio,
} from "../../src/server/qa-fixers/contrast";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("category-level contrast remediation", () => {
  it("preserves the brand hue while finding an AA foreground", () => {
    const fixed = accessibleBrandColor("rgb(49,87,246)", ["rgb(240,195,108)"], 4.5);
    expect(fixed).not.toBeNull();
    expect(contrastRatio(fixed!, "rgb(240,195,108)")).toBeGreaterThanOrEqual(4.5);
    expect(fixed).not.toBe("rgb(0,0,0)");
    expect(fixed).not.toBe("rgb(255,255,255)");
  });

  it("repairs every measured selector in its owning HTML file and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-contrast-fixer-"));
    roots.push(root);
    await mkdir(join(root, "compositions"));
    await writeFile(
      join(root, "index.html"),
      "<!doctype html><html><head></head><body><div><span>/</span></div></body></html>",
      "utf8",
    );
    await writeFile(
      join(root, "compositions", "02-compose.html"),
      '<template><style>.label{color:#3157f6}</style><span data-hf-id="active-change">Active change</span></template>',
      "utf8",
    );
    const qa = contrastQa();
    const fixer = new ContrastFixer();
    const result = await fixer.apply(root, qa, ["index.html", "compositions/**"]);

    expect(result.repaired).toHaveLength(2);
    expect(result.repaired.every((repair) => repair.strategy === "foreground")).toBe(true);
    const index = await readFile(join(root, "index.html"), "utf8");
    const composition = await readFile(join(root, "compositions", "02-compose.html"), "utf8");
    expect(index).toContain('data-sequences-qa-fixer="contrast-v1"');
    expect(index.indexOf("data-sequences-qa-fixer")).toBeLessThan(index.indexOf("</head>"));
    expect(composition).toContain('[data-hf-id="active-change"]');
    expect(composition.indexOf("data-sequences-qa-fixer")).toBeLessThan(
      composition.indexOf("</template>"),
    );

    const second = await fixer.apply(root, qa, ["index.html", "compositions/**"]);
    expect(second.repaired).toEqual([]);
  });
});

function contrastQa(): QaReceiptV1 {
  return {
    version: "sequences.qa-receipt.v1",
    hyperframesVersion: "0.7.56",
    ok: false,
    commands: [
      { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
      { command: "check", ok: false, exitCode: 1, durationMs: 1, artifact: "check.json" },
    ],
    summary: { errorCount: 1, warningCount: 1, infoCount: 0 },
    findings: [
      finding("error", "index.html", "div > span:nth-of-type(1)"),
      {
        ...finding("warning", "compositions/02-compose.html", "span"),
        identity: { hfId: "active-change" },
      },
    ],
  };
}

function finding(
  severity: "error" | "warning",
  sourceFile: string,
  selector: string,
): QaReceiptV1["findings"][number] {
  return {
    command: "check",
    category: "contrast",
    code: "contrast_aa_failure",
    severity,
    sourceFile,
    selector,
    times: [1],
    message: "Contrast is 3.33:1; WCAG AA requires 4.5:1.",
    fixHint: null,
    contrast: {
      samples: [
        {
          foreground: "rgb(49,87,246)",
          background: "rgb(240,195,108)",
          ratio: 3.33,
          requiredRatio: 4.5,
          suggestedColor: "rgb(40,71,200)",
        },
      ],
    },
    artifact: "check.json",
  };
}
