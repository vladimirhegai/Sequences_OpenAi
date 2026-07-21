import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerConfig } from "../../src/server/config";
import {
  boundQaReceiptFindings,
  canAdjudicateLayoutFailure,
  normalizeQaFindings,
} from "../../src/server/hyperframes";
import { HyperframesVerifier } from "../../src/server/hyperframes";
import {
  MAX_QA_RECEIPT_FINDINGS,
  QaReceiptV1Schema,
  type QaFindingV1,
  type SequenceArtifactV1,
} from "../../src/shared";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Hyperframes QA evidence", () => {
  it("accepts realistic reports above 100 findings and bounds extremes severity-first", () => {
    const finding = (index: number, severity: QaFindingV1["severity"]): QaFindingV1 => ({
      command: "check",
      category: "contrast",
      code: `finding_${String(index)}`,
      severity,
      sourceFile: "index.html",
      selector: `#node-${String(index)}`,
      times: [1],
      message: `Finding ${String(index)}`,
      fixHint: null,
      artifact: "check.json",
    });
    const realistic = Array.from({ length: 101 }, (_, index) => finding(index, "warning"));

    expect(() =>
      QaReceiptV1Schema.parse({
        version: "sequences.qa-receipt.v1",
        hyperframesVersion: "0.7.56",
        ok: false,
        commands: [
          { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
          { command: "check", ok: false, exitCode: 1, durationMs: 1, artifact: "check.json" },
        ],
        summary: { errorCount: 0, warningCount: realistic.length, infoCount: 0 },
        findings: realistic,
      }),
    ).not.toThrow();

    const extreme = [
      ...Array.from({ length: MAX_QA_RECEIPT_FINDINGS }, (_, index) => finding(index, "info")),
      finding(MAX_QA_RECEIPT_FINDINGS, "error"),
    ];
    const bounded = boundQaReceiptFindings(extreme);
    expect(bounded).toHaveLength(MAX_QA_RECEIPT_FINDINGS);
    expect(bounded[0]?.severity).toBe("error");
  });

  it("demotes renderer-only layout artifacts while preserving persistent defects", () => {
    const rawReport = {
      ok: false,
      runtime: { ok: true },
      layout: {
        ok: false,
        findings: [
          {
            code: "clipped_text",
            severity: "error",
            time: 1,
            firstSeen: 1,
            lastSeen: 1.1,
            occurrences: 2,
            sourceFile: "compositions/01-hook.html",
            selector: '[data-hf-inner-root="true"]',
            message: "Structural wrapper clips aggregate descendant text during entrance.",
            dataAttributes: { "data-hf-inner-root": "true" },
          },
          {
            code: "clipped_text",
            severity: "error",
            time: 5.556,
            firstSeen: 5.556,
            lastSeen: 8,
            occurrences: 10,
            sourceFile: "compositions/02-compose.html",
            selector: "#launch-scene > div:nth-of-type(1)",
            message: "Persistent full-canvas aggregate clipping.",
            rect: {
              left: 0,
              top: 0,
              right: 1920,
              bottom: 1080,
              width: 1920,
              height: 1080,
            },
            dataAttributes: {
              "data-hf-inner-root": "true",
              "data-hf-id": "product-world",
              "data-width": "1920",
              "data-height": "1080",
            },
          },
        ],
      },
      motion: { ok: true },
      contrast: { ok: true },
    };
    const findings = normalizeQaFindings("check", rawReport);

    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.severity === "info")).toBe(true);
    expect(
      findings.find((finding) => finding.message === "Persistent full-canvas aggregate clipping.")
        ?.severity,
    ).toBe("info");
    expect(
      canAdjudicateLayoutFailure(
        [
          { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
          { command: "check", ok: false, exitCode: 1, durationMs: 1, artifact: "check.json" },
        ],
        findings,
        [],
        rawReport,
        { markers: [], violations: [] },
      ),
    ).toBe(true);

    const persistent = normalizeQaFindings("check", {
      layout: {
        findings: [
          {
            code: "clipped_text",
            severity: "error",
            firstSeen: 1,
            lastSeen: 1.4,
            occurrences: 3,
            sourceFile: "index.html",
            selector: '[data-hf-inner-root="true"]',
            message: "Persistent clipping.",
            dataAttributes: { "data-hf-inner-root": "true" },
          },
        ],
      },
    });
    expect(persistent[0]?.severity).toBe("error");

    const handoff = normalizeQaFindings("check", {
      layout: {
        findings: [
          {
            code: "content_overlap",
            severity: "error",
            firstSeen: 2.76,
            lastSeen: 2.82,
            occurrences: 2,
            sourceFile: "compositions/product.html",
            selector: "#outgoing-title",
            message: "Text overlaps during a two-frame handoff.",
          },
        ],
      },
    });
    expect(handoff[0]?.severity).toBe("info");

    const persistentOverlap = normalizeQaFindings("check", {
      layout: {
        findings: [
          {
            code: "content_overlap",
            severity: "error",
            firstSeen: 3.1,
            lastSeen: 4.9,
            occurrences: 36,
            sourceFile: "compositions/product.html",
            selector: "#ticket-body",
            message: "Persistent product copy collision.",
          },
        ],
      },
    });
    expect(persistentOverlap[0]?.severity).toBe("error");
  });

  it("aggregates repeated sampled findings into one actionable receipt finding", () => {
    const findings = normalizeQaFindings("check", {
      ok: false,
      contrast: {
        findings: [
          {
            code: "contrast_aa_failure",
            severity: "error",
            time: 1.735,
            sourceFile: "compositions\\01-evidence.html",
            selector: ".meter-ticks > span:nth-child(1)",
            message: "Contrast is 2.89:1; WCAG AA requires 4.5:1.",
            fg: "rgb(138,142,150)",
            bg: "rgb(243,240,232)",
            ratio: 2.89,
            requiredRatio: 4.5,
            suggestedColor: "rgb(106,109,115)",
            dataAttributes: { "data-hf-id": "meter-tick-0" },
          },
          {
            code: "contrast_aa_failure",
            severity: "error",
            time: 3.62,
            sourceFile: "compositions\\01-evidence.html",
            selector: ".meter-ticks > span:nth-child(1)",
            message: "Contrast is 2.89:1; WCAG AA requires 4.5:1.",
            fg: "rgb(138,142,150)",
            bg: "rgb(243,240,232)",
            ratio: 2.89,
            requiredRatio: 4.5,
            suggestedColor: "rgb(106,109,115)",
            dataAttributes: { "data-hf-id": "meter-tick-0" },
          },
          {
            code: "contrast_aa_failure",
            severity: "warning",
            time: 1.735,
            sourceFile: "compositions/01-evidence.html",
            selector: ".meter-topline strong",
            message: "Contrast is 3.23:1; WCAG AA requires 4.5:1.",
          },
        ],
      },
    });

    expect(findings).toEqual([
      {
        command: "check",
        category: "contrast",
        code: "contrast_aa_failure",
        severity: "error",
        sourceFile: "compositions/01-evidence.html",
        selector: ".meter-ticks > span:nth-child(1)",
        times: [1.735, 3.62],
        message: "Contrast is 2.89:1; WCAG AA requires 4.5:1.",
        fixHint: null,
        identity: { hfId: "meter-tick-0" },
        contrast: {
          samples: [
            {
              foreground: "rgb(138,142,150)",
              background: "rgb(243,240,232)",
              ratio: 2.89,
              requiredRatio: 4.5,
              suggestedColor: "rgb(106,109,115)",
            },
          ],
        },
        artifact: "check.json",
      },
      {
        command: "check",
        category: "contrast",
        code: "contrast_aa_failure",
        severity: "warning",
        sourceFile: "compositions/01-evidence.html",
        selector: ".meter-topline strong",
        times: [1.735],
        message: "Contrast is 3.23:1; WCAG AA requires 4.5:1.",
        fixHint: null,
        artifact: "check.json",
      },
    ]);
  });

  it("bounds long sampled time series while retaining first and last evidence", () => {
    const findings = normalizeQaFindings("check", {
      layout: {
        findings: Array.from({ length: 40 }, (_, time) => ({
          code: "container_overflow",
          severity: "info",
          time,
          sourceFile: "index.html",
          selector: "#ambient-ring",
          message: "Ambient decoration extends beyond its clipped canvas.",
        })),
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.times).toHaveLength(30);
    expect(findings[0]?.times[0]).toBe(0);
    expect(findings[0]?.times.at(-1)).toBe(39);
  });

  it("writes normalized strict-check findings into the durable QA receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-qa-findings-"));
    roots.push(root);
    const cli = join(root, "node_modules", "hyperframes", "dist", "cli.js");
    await mkdir(join(cli, ".."), { recursive: true });
    await writeFile(
      cli,
      [
        'const { writeFileSync } = require("node:fs");',
        'const { join } = require("node:path");',
        "const command = process.argv[2];",
        'if (command === "--version") console.log("0.7.56");',
        'else if (command === "lint") console.log(JSON.stringify({ ok: true, errorCount: 0, warningCount: 0, findings: [] }));',
        'else if (command === "check") {',
        '  writeFileSync(join(process.cwd(), "..", "check-argv.json"), JSON.stringify(process.argv.slice(2)));',
        "  console.log(JSON.stringify({ ok: false, contrast: { findings: [",
        '    { code: "contrast_aa_failure", severity: "error", time: 1.7, sourceFile: "index.html", selector: ".caption", message: "Contrast is 2.89:1; WCAG AA requires 4.5:1." },',
        '    { code: "contrast_aa_failure", severity: "error", time: 3.6, sourceFile: "index.html", selector: ".caption", message: "Contrast is 2.89:1; WCAG AA requires 4.5:1." }',
        "  ] } }));",
        "  process.exitCode = 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    const candidateRoot = join(root, "candidate");
    const runRoot = join(root, "run");
    await mkdir(candidateRoot);
    await mkdir(runRoot);
    await writeFile(join(candidateRoot, "index.html"), "<main>Candidate</main>", "utf8");

    const verifier = new HyperframesVerifier(
      createServerConfig({ workspaceRoot: root, hyperframesCommand: process.execPath }),
    );
    const receipt = await verifier.verify(
      "run_00000000000000000000000000000000",
      candidateRoot,
      runRoot,
    );

    expect(receipt.ok).toBe(false);
    expect(JSON.parse(await readFile(join(runRoot, "check-argv.json"), "utf8"))).toContain(
      "--strict",
    );
    expect(receipt.summary).toEqual({ errorCount: 1, warningCount: 0, infoCount: 0 });
    expect(receipt.findings).toEqual([
      expect.objectContaining({
        category: "contrast",
        sourceFile: "index.html",
        times: [1.7, 3.6],
        artifact: "check.json",
      }),
    ]);
  });

  it("records detector indeterminacy without adding a synthetic blocker for one-box geometry", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-qa-layout-inspection-"));
    roots.push(root);
    const cli = join(root, "node_modules", "hyperframes", "dist", "cli.js");
    await mkdir(join(cli, ".."), { recursive: true });
    await writeFile(
      cli,
      [
        "const command = process.argv[2];",
        'if (command === "--version") console.log("0.7.56");',
        'else if (command === "lint") console.log(JSON.stringify({ ok: true, errorCount: 0, warningCount: 0, findings: [] }));',
        'else if (command === "check") {',
        "  console.log(JSON.stringify({ ok: false, runtime: { ok: true, findings: [] }, layout: { ok: false, findings: [",
        '    { code: "content_overlap", severity: "error", time: 1, sourceFile: "index.html", selector: "span.title-line", containerSelector: "span.title-line", message: "Two text blocks overlap.", rect: { left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }, firstSeen: 1, lastSeen: 2, occurrences: 2 }',
        "  ] }, motion: { ok: true, findings: [] }, contrast: { ok: true, findings: [] } }));",
        "  process.exitCode = 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    const candidateRoot = join(root, "candidate");
    const runRoot = join(root, "run");
    await mkdir(candidateRoot);
    await mkdir(runRoot);
    await writeFile(
      join(candidateRoot, "index.html"),
      '<main><span class="title-line">One</span><span class="title-line">Two</span></main>',
      "utf8",
    );
    const sequence: SequenceArtifactV1 = {
      version: "sequences.sequence.v1",
      concept: {
        summary: "Show two title lines.",
        hierarchy: ["Title"],
        motionGrammar: ["Reveal"],
        rejectedChoices: [],
      },
      beats: [
        {
          id: "title-beat",
          purpose: "Reveal the title.",
          claims: [],
          entities: [
            { id: "headline", role: "Primary title line.", parts: [] },
            { id: "headline-peer", role: "Secondary title line.", parts: [] },
          ],
          sourceIds: [],
          musicAnchors: [],
          proofTimes: [1],
          implementationFiles: ["index.html"],
        },
      ],
      overlapIntents: [],
      revision: null,
    };

    const verifier = new HyperframesVerifier(
      createServerConfig({ workspaceRoot: root, hyperframesCommand: process.execPath }),
      async () => {
        throw new Error("No intersecting entity pair could be resolved for the layout cluster");
      },
    );
    const receipt = await verifier.verify(
      "run_00000000000000000000000000000000",
      candidateRoot,
      runRoot,
      { artifactDirectory: "qa/attempt-1", sequence },
    );

    expect(receipt.ok).toBe(false);
    expect(receipt.layoutClusters).toEqual([
      expect.objectContaining({
        status: "undeclared",
        sourceFiles: ["index.html"],
      }),
    ]);
    expect(receipt.summary).toEqual({ errorCount: 1, warningCount: 1, infoCount: 0 });
    expect(receipt.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "content_overlap", severity: "error" }),
        expect.objectContaining({
          category: "layout_inspection",
          code: "layout_inspection_failed",
          severity: "warning",
          sourceFile: "index.html",
          artifact: "qa/attempt-1/check.json",
          message: expect.stringMatching(
            /Layout detector indeterminate.*No intersecting entity pair could be resolved/,
          ),
          fixHint: expect.stringContaining("not identify an actionable entity pair"),
        }),
      ]),
    );
    const durableReceipt = JSON.parse(
      await readFile(join(runRoot, "qa", "attempt-1", "qa.json"), "utf8"),
    ) as { findings: Array<{ code: string }> };
    expect(durableReceipt.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "layout_inspection_failed" })]),
    );
  });

  it("never reports QA success when host overlap policy adds a blocking finding", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-qa-policy-blocker-"));
    roots.push(root);
    const cli = join(root, "node_modules", "hyperframes", "dist", "cli.js");
    await mkdir(join(cli, ".."), { recursive: true });
    await writeFile(
      cli,
      [
        "const command = process.argv[2];",
        'if (command === "--version") console.log("0.7.56");',
        'else if (command === "lint") console.log(JSON.stringify({ ok: true, errorCount: 0, warningCount: 0, findings: [] }));',
        'else if (command === "check") console.log(JSON.stringify({ ok: true, runtime: { ok: true, findings: [] }, layout: { ok: true, findings: [] }, motion: { ok: true, findings: [] }, contrast: { ok: true, findings: [] } }));',
      ].join("\n"),
      "utf8",
    );
    const candidateRoot = join(root, "candidate");
    const runRoot = join(root, "run");
    await mkdir(candidateRoot);
    await mkdir(runRoot);
    await writeFile(
      join(candidateRoot, "index.html"),
      '<main data-hf-id="hero" data-layout-allow-overlap>Hero</main>',
      "utf8",
    );
    const sequence: SequenceArtifactV1 = {
      version: "sequences.sequence.v1",
      concept: {
        summary: "Show a hero.",
        hierarchy: ["Hero"],
        motionGrammar: ["Reveal"],
        rejectedChoices: [],
      },
      beats: [
        {
          id: "hero-beat",
          purpose: "Reveal the hero.",
          claims: [],
          entities: [{ id: "hero", role: "Primary hero.", parts: [] }],
          sourceIds: [],
          musicAnchors: [],
          proofTimes: [0],
          implementationFiles: ["index.html"],
        },
      ],
      overlapIntents: [],
      revision: null,
    };
    const verifier = new HyperframesVerifier(
      createServerConfig({ workspaceRoot: root, hyperframesCommand: process.execPath }),
    );

    const receipt = await verifier.verify(
      "run_00000000000000000000000000000000",
      candidateRoot,
      runRoot,
      { sequence },
    );

    expect(receipt.commands).toEqual([
      expect.objectContaining({ command: "lint", ok: true }),
      expect.objectContaining({ command: "check", ok: true }),
    ]);
    expect(receipt.ok).toBe(false);
    expect(receipt.summary.errorCount).toBe(1);
    expect(receipt.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "overlap_marker_broad_suppression", severity: "error" }),
      ]),
    );
  });

  it("removes the isolated QA workspace when verification throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "sequences-qa-cleanup-"));
    roots.push(root);
    const candidateRoot = join(root, "candidate");
    const runRoot = join(root, "run");
    await mkdir(candidateRoot);
    await mkdir(runRoot);
    await writeFile(join(candidateRoot, "index.html"), "<main>Candidate</main>", "utf8");

    const verifier = new HyperframesVerifier(
      createServerConfig({ workspaceRoot: root, hyperframesCommand: process.execPath }),
    );
    await expect(
      verifier.verify("run_00000000000000000000000000000000", candidateRoot, runRoot, {
        artifactDirectory: "qa/attempt-10",
      }),
    ).rejects.toThrow("outside the bounded attempt ledger");
    await expect(stat(join(runRoot, "qa-workspace"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
