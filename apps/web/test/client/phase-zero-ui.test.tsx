import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { JobCard, QaFailureDetails } from "../../src/client/App";
import type { JobResponse } from "../../src/client/api";
import { SequencesStudio, StudioTimeline } from "../../src/client/SequencesStudio";

describe("Phase 0 studio UI", () => {
  it("shows an honest empty timeline before the player reports real timing", () => {
    const markup = renderToStaticMarkup(
      <StudioTimeline ready={false} duration={0} time={0} clips={[]} onSeek={vi.fn()} />,
    );

    expect(markup).toContain("Waiting for preview");
    expect(markup).toContain("timeline will appear");
    expect(markup).not.toContain("Scene 01");
  });

  it("uses a native draggable range input when real timing is available", () => {
    const markup = renderToStaticMarkup(
      <StudioTimeline ready duration={12} time={3} clips={[]} onSeek={vi.fn()} />,
    );

    expect(markup).toContain('type="range"');
    expect(markup).toContain('aria-valuetext="0:03 of 0:12"');
    expect(markup).toContain("No scene markers in this video");
  });

  it("renders the featured ChatGPT MP4 through the real viewer transport", () => {
    const markup = renderToStaticMarkup(
      <SequencesStudio
        mode="video"
        mediaSource="/api/v1/showcases/chatgpt-native-story/video"
        poster="/api/v1/showcases/chatgpt-native-story/poster"
        clipLabel="ChatGPT native story"
        label="ChatGPT: From question to working draft"
      />,
    );

    expect(markup).toContain('<video src="/api/v1/showcases/chatgpt-native-story/video"');
    expect(markup).toContain('aria-label="ChatGPT: From question to working draft"');
    expect(markup).toContain('aria-label="Play"');
    expect(markup).toContain("Verified showcase");
  });

  it("does not expose fake workflow tabs or the underlying engine name", () => {
    const app = readFileSync(resolve("apps/web/src/client/App.tsx"), "utf8");
    const studio = readFileSync(resolve("apps/web/src/client/SequencesStudio.tsx"), "utf8");

    expect(app).not.toContain("workflow-stepper");
    expect(studio).not.toContain("FALLBACK_CLIPS");
    expect(app).not.toMatch(/["'`][^"'`\r\n]*hyperframes/i);
  });

  it("keeps generation, watch-only timeline, and delivery in the main website flow", () => {
    const app = readFileSync(resolve("apps/web/src/client/App.tsx"), "utf8");
    const mainFlow = app.slice(0, app.indexOf("export function JobCard"));

    expect(mainFlow).toContain("What do you want to make?");
    expect(mainFlow).toContain('pending === "cancel" ? "Stopping…" : "Stop generation"');
    expect(mainFlow).toContain("<JobCard");
    expect(mainFlow).toContain("<RenderCard");
    expect(mainFlow).toContain('<span className="eyebrow">Timeline</span>');
    expect(mainFlow).not.toContain('job?.receipt.state === "review_ready" && pending === null');
    expect(mainFlow).toContain("revisionedSource(");
    expect(mainFlow).not.toContain("Use this version");
    expect(mainFlow).not.toContain("Discard version");
    expect(mainFlow).not.toContain("Current version");
    expect(mainFlow).not.toContain("Start Luna without earlier context");
  });

  it("orders the homepage as title, viewer, prompt, and Showcase or Recent library", () => {
    const app = readFileSync(resolve("apps/web/src/client/App.tsx"), "utf8");
    const mainFlow = app.slice(0, app.indexOf("export function JobCard"));
    const titleAt = mainFlow.indexOf('id="page-title"');
    const viewerAt = mainFlow.indexOf('className="studio-panel"');
    const promptAt = mainFlow.indexOf('className="create-panel"');
    const libraryAt = mainFlow.indexOf('className="library"');

    expect(titleAt).toBeGreaterThan(0);
    expect(viewerAt).toBeGreaterThan(titleAt);
    expect(promptAt).toBeGreaterThan(viewerAt);
    expect(libraryAt).toBeGreaterThan(promptAt);
    expect(mainFlow).toContain('setLibraryTab("showcase")');
    expect(mainFlow).toContain('setLibraryTab("recent")');
    expect(mainFlow).toContain("/api/v1/showcases/chatgpt-native-story/video");
    expect(mainFlow).toContain('useState<ViewerSource>("featured")');
    expect(mainFlow).toContain("!HIDDEN_RECENT_STATES.has(recentJob.state)");
    expect(mainFlow).toContain("recentJobs.map((recentJob)");
  });

  it("uses the beige editorial skin and sizes the complete viewer against the first viewport", () => {
    const styles = readFileSync(resolve("apps/web/src/client/styles.css"), "utf8");

    expect(styles).toContain("color-scheme: light");
    expect(styles).not.toContain("color-scheme: dark");
    expect(styles).toContain("calc((100vh - 380px) * 1.7778)");
    expect(styles).toContain("font-size: clamp(46px, 6vw, 64px)");
    expect(styles).toContain("background: #eee7db");
  });

  it("streams Luna activity only while the current job is active", () => {
    const app = readFileSync(resolve("apps/web/src/client/App.tsx"), "utf8");
    const subscription = app.slice(
      app.indexOf("if (!api || !job)"),
      app.indexOf("useEffect(() => setJobEvents([])"),
    );

    expect(subscription).toContain("if (!STREAMING_JOB_STATES.has(job.receipt.state)) return;");
    expect(subscription).toContain("job?.receipt.state");
  });

  it("does not render corrupted punctuation or accept/reject wording", () => {
    const app = readFileSync(resolve("apps/web/src/client/App.tsx"), "utf8");

    expect(app).not.toMatch(/[ÂÃ]/);
    expect(app).not.toContain("â€¦");
    expect(app).not.toContain("was not applied");
    expect(app).not.toContain("Accept candidate");
    expect(app).not.toContain("Reject candidate");
  });

  it("shows Luna activity and elapsed time without lifecycle controls", () => {
    const markup = renderToStaticMarkup(
      <JobCard job={jobResponse("authoring")} events={[]} elapsedMs={154_000} />,
    );

    expect(markup).toContain("Luna");
    expect(markup).toContain("Luna is creating the video source.");
    expect(markup).toContain("02:34");
    expect(markup).toContain(`data-job-id="run_${"a".repeat(32)}"`);
    expect(markup).toContain('data-job-outcome="active"');
    expect(markup).not.toContain("Apply");
    expect(markup).not.toContain("Candidate");
  });

  it("turns an obsolete internal run into a simple retry status", () => {
    const markup = renderToStaticMarkup(
      <JobCard job={jobResponse("stale")} events={[]} elapsedMs={1_000} />,
    );

    expect(markup).toContain("Superseded");
    expect(markup).toContain("This generation was superseded; generate again.");
    expect(markup).not.toMatch(/\bstale\b/i);
    expect(markup).not.toContain("project changed");
  });

  it("explains QA failures with their source and sampled times", () => {
    const markup = renderToStaticMarkup(
      <QaFailureDetails
        qa={{
          version: "sequences.qa-receipt.v1",
          hyperframesVersion: "0.7.56",
          ok: false,
          commands: [
            { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
            {
              command: "check",
              ok: false,
              exitCode: 1,
              durationMs: 1,
              artifact: "check.json",
              error: "Strict check failed",
            },
          ],
          summary: { errorCount: 1, warningCount: 1, infoCount: 0 },
          findings: [
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
          ],
        }}
      />,
    );

    expect(markup).toContain("QA needs changes");
    expect(markup).toContain(
      "1 blocking finding must be fixed before the video can reach the timeline.",
    );
    expect(markup).toContain("1 warning also needs attention.");
    expect(markup).toContain("compositions/01-evidence.html");
    expect(markup).toContain("1.74s, 3.62s");
    expect(markup).toContain("Contrast is 2.89:1");
  });

  it("presents one transition decision instead of descendant-level overlap noise", () => {
    const layoutFindings = Array.from({ length: 20 }, (_, index) => ({
      command: "check" as const,
      category: "layout",
      code: index < 18 ? "content_overlap" : "text_occluded",
      severity: "error" as const,
      sourceFile: index < 18 ? "compositions/02-compose.html" : "compositions/03-receipt.html",
      selector: `.descendant-${index}`,
      times: [10.815],
      message: "Element overlaps during the handoff.",
      fixHint: null,
      artifact: "qa/attempt-1/check.json",
    }));
    const markup = renderToStaticMarkup(
      <QaFailureDetails
        qa={{
          version: "sequences.qa-receipt.v1",
          hyperframesVersion: "0.7.56",
          ok: false,
          commands: [
            { command: "lint", ok: true, exitCode: 0, durationMs: 1, artifact: "lint.json" },
            { command: "check", ok: false, exitCode: 1, durationMs: 1, artifact: "check.json" },
          ],
          summary: { errorCount: 20, warningCount: 0, infoCount: 0 },
          findings: layoutFindings,
          layoutClusters: [
            {
              id: "handoff-10815",
              kind: "handoff",
              status: "undeclared",
              sampleTime: 10.815,
              timeRange: [10.815, 10.833],
              findingCount: 20,
              observationCount: 25,
              beatIds: ["compose-workspace", "verified-receipt"],
              compositionIds: ["compose-workspace", "verified-receipt"],
              sourceFiles: ["compositions/02-compose.html", "compositions/03-receipt.html"],
              entityIds: ["editor-canvas", "release-receipt"],
              intentId: null,
              summary: "One covering transition layer produced twenty descendant findings.",
              artifacts: {
                inspection: "qa/attempt-1/layout/clusters/handoff-10815/inspection.json",
                fullFrame: "qa/attempt-1/layout/clusters/handoff-10815/full-frame.png",
                crop: "qa/attempt-1/layout/clusters/handoff-10815/focus.png",
              },
            },
          ],
        }}
      />,
    );

    expect(markup).toContain(
      "Compose workspace → Verified receipt handoff caused one unresolved layout cluster at 10.815s, affecting 20 descendants.",
    );
    expect(markup).toContain(
      "1 blocking finding must be fixed before the video can reach the timeline.",
    );
    expect(markup).not.toContain(".descendant-0");
  });
});

function jobResponse(state: "authoring" | "stale"): JobResponse {
  const timestamp = "2026-07-15T12:00:00.000Z";
  const jobId = `run_${"a".repeat(32)}`;
  return {
    version: "sequences.job-response.v1",
    eventsUrl: `/api/v1/jobs/${jobId}/events`,
    candidateUrl: `/candidate/${jobId}/index.html`,
    receipt: {
      version: "sequences.run-receipt.v1",
      jobId,
      projectId: "release-a",
      kind: "build",
      state,
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: timestamp,
      baseCommit: "1".repeat(40),
      candidateRef: `candidate:${jobId}`,
      candidateCommit: "2".repeat(40),
      acceptedCommit: null,
      patchSha256: "3".repeat(64),
      inversePatchSha256: "4".repeat(64),
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      codexCliVersion: "codex-test",
      sanitizedArguments: [],
      allowedPaths: ["index.html"],
      changedFiles: ["index.html"],
      skillManifestDigest: "5".repeat(64),
      skillsUsed: ["hyperframes", "general-video"],
      exitCode: 0,
      timedOut: false,
      cancelRequested: false,
      final: null,
      qa: null,
      qaRemediations: [],
      layoutRepairs: [],
      agentWorkflow: {
        version: "sequences.agent-workflow.v1",
        mode: "legacy",
        componentSpecialist: false,
        turns: [],
        compositorThreadId: null,
        temporalEvidenceArtifact: null,
        visualAuditArtifact: null,
      },
      visualAudit: null,
      director: null,
      context: null,
      proofComparison: null,
      decision: null,
      error:
        state === "stale" ? { code: "stale_base", message: "Apply blocked", owner: "git" } : null,
    },
  };
}
