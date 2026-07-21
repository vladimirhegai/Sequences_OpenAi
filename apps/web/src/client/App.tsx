import { useCallback, useEffect, useRef, useState } from "react";
import type { JobState, QaReceiptV1, RenderState } from "../shared";
import {
  ApiRequestError,
  MissingLocalSessionError,
  SequencesApi,
  type JobEvent,
  type JobResponse,
  type RenderResponse,
  type WorkspaceBootstrap,
} from "./api";
import { SequencesStudio } from "./SequencesStudio";
import { ImageAttachments, type ImageAttachmentSummary } from "./ImageAttachments";

const PROJECT_ID = "release-a";

const SHOWCASES = [
  {
    id: "chatgpt-native-story",
    title: "ChatGPT: From question to working draft",
    description:
      "A native product story with streamed responses, persistent UI, measured pointer work, and a polished lockup.",
    duration: "24 sec",
  },
  {
    id: "chatgpt-ad",
    title: "This is ChatGPT",
    description:
      "A fast product-led ChatGPT launch film with focused interaction and a clean brand resolve.",
    duration: "28 sec",
  },
  {
    id: "sequences-abstract-ad",
    title: "Sequences — Make your prompt move",
    description:
      "An abstract, motion-first introduction to turning one prompt into a launch-ready sequence.",
    duration: "30 sec",
  },
  {
    id: "sequences-recommendation-ad",
    title: "Sequences recommendation launch",
    description:
      "A compact SaaS story built around product recommendations, proof, and a decisive finish.",
    duration: "24 sec",
  },
] as const;

type ShowcaseId = (typeof SHOWCASES)[number]["id"];
type ViewerSelection =
  | { kind: "showcase"; id: ShowcaseId }
  | { kind: "composition"; jobId: string | null; label: string };

const LIVE_STATES = new Set<JobState>(["queued", "preparing", "authoring", "verifying"]);
const STREAMING_JOB_STATES = new Set<JobState>([...LIVE_STATES, "applying"]);
const LIVE_RENDER_STATES = new Set<RenderState>(["queued", "preparing", "rendering", "verifying"]);
const STATE_LABELS: Record<JobState, string> = {
  queued: "Queued",
  preparing: "Preparing",
  authoring: "Authoring",
  verifying: "Verifying",
  review_ready: "Finalizing",
  applying: "Applying",
  applied: "Complete",
  rejected: "Discarded",
  stale: "Superseded",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
};

type LoadState = "loading" | "ready" | "error";
type PendingAction = "build" | "cancel" | "render" | "cancel-render" | null;
type LibraryTab = "showcase" | "recent";

export function App() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [api, setApi] = useState<SequencesApi | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceBootstrap | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [visibleJobId, setVisibleJobId] = useState<string | null>(null);
  const [jobEvents, setJobEvents] = useState<JobEvent[]>([]);
  const [render, setRender] = useState<RenderResponse | null>(null);
  const [prompt, setPrompt] = useState("");
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  const [attachmentsBlocked, setAttachmentsBlocked] = useState(false);
  const [attachmentBatch, setAttachmentBatch] = useState(0);
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [libraryTab, setLibraryTab] = useState<LibraryTab>("showcase");
  const [viewerSelection, setViewerSelection] = useState<ViewerSelection>({
    kind: "showcase",
    id: "chatgpt-native-story",
  });
  const viewerPanelRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const launchedJobIdRef = useRef<string | null>(null);
  const startupRef = useRef<Promise<{ api: SequencesApi; workspace: WorkspaceBootstrap }> | null>(
    null,
  );
  const elapsedMs = useElapsedTime(job);

  const showInViewer = useCallback((selection: ViewerSelection) => {
    setViewerSelection(selection);
    window.requestAnimationFrame(() => {
      viewerPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const updateAttachments = useCallback((summary: ImageAttachmentSummary) => {
    setImagePaths(summary.paths);
    setAttachmentsBlocked(summary.busy || summary.hasErrors);
  }, []);

  useEffect(() => {
    let disposed = false;
    startupRef.current ??= initializeWorkspace();

    void startupRef.current
      .then(async ({ api: nextApi, workspace: nextWorkspace }) => {
        if (disposed) return;
        setApi(nextApi);
        setWorkspace(nextWorkspace);

        const lastJob = nextWorkspace.project.jobs[0];
        if (lastJob) {
          try {
            const nextJob = await nextApi.getJob(lastJob.id);
            if (!disposed) {
              setJob(nextJob);
              setVisibleJobId(nextJob.receipt.jobId);
            }
          } catch {
            // A deleted or incomplete old receipt does not block the workspace.
          }
        }
        const lastRender = nextWorkspace.project.renders[0];
        if (lastRender) {
          try {
            const nextRender = await nextApi.getRender(lastRender.id);
            if (!disposed) setRender(nextRender);
          } catch {
            // A missing old render receipt does not block authoring or playback.
          }
        }
        if (!disposed) setLoadState("ready");
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setLoadError(reason instanceof Error ? reason : new Error("Sequences failed to start."));
        setLoadState("error");
      });

    return () => {
      disposed = true;
    };
  }, []);

  const refreshJob = useCallback(
    async (jobId: string): Promise<JobResponse | null> => {
      if (!api) return null;
      try {
        const nextJob = await api.getJob(jobId);
        setJob(nextJob);
        return nextJob;
      } catch (reason: unknown) {
        setError(toApiError(reason));
        return null;
      }
    },
    [api],
  );

  useEffect(() => {
    if (!api || loadState !== "ready") return;
    let disposed = false;
    let syncing = false;

    const syncWorkspace = async () => {
      if (syncing) return;
      syncing = true;
      try {
        const nextWorkspace = await api.bootstrap();
        if (disposed) return;
        setWorkspace(nextWorkspace);

        const latestJob = nextWorkspace.project.jobs[0];
        if (
          latestJob &&
          (latestJob.id !== job?.receipt.jobId || latestJob.state !== job.receipt.state)
        ) {
          const nextJob = await api.getJob(latestJob.id);
          if (!disposed) {
            setJob(nextJob);
            setVisibleJobId(nextJob.receipt.jobId);
          }
        }

        const latestRender = nextWorkspace.project.renders[0];
        if (
          latestRender &&
          (latestRender.id !== render?.receipt.renderId ||
            latestRender.state !== render.receipt.state)
        ) {
          const nextRender = await api.getRender(latestRender.id);
          if (!disposed) setRender(nextRender);
        }
      } catch {
        // Passive discovery must not interrupt authoring. Direct actions still
        // surface their API failures through the normal error notice.
      } finally {
        syncing = false;
      }
    };

    const timer = window.setInterval(() => void syncWorkspace(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    api,
    job?.receipt.jobId,
    job?.receipt.state,
    loadState,
    render?.receipt.renderId,
    render?.receipt.state,
  ]);

  useEffect(() => {
    if (!job || !LIVE_STATES.has(job.receipt.state)) return;
    const timer = window.setInterval(() => void refreshJob(job.receipt.jobId), 2_000);
    return () => window.clearInterval(timer);
  }, [job, refreshJob]);

  useEffect(() => {
    if (!api || !job) {
      setJobEvents([]);
      return;
    }
    if (!STREAMING_JOB_STATES.has(job.receipt.state)) return;
    return api.subscribeToJob(
      job.eventsUrl,
      (event) => {
        setJobEvents((current) =>
          current.some((item) => item.sequence === event.sequence)
            ? current
            : [...current, event].slice(-6),
        );
        void refreshJob(job.receipt.jobId);
      },
      () => undefined,
    );
  }, [api, job?.eventsUrl, job?.receipt.jobId, job?.receipt.state, refreshJob]);

  useEffect(() => setJobEvents([]), [job?.receipt.jobId]);

  const refreshRender = useCallback(
    async (renderId: string): Promise<RenderResponse | null> => {
      if (!api) return null;
      try {
        const nextRender = await api.getRender(renderId);
        setRender(nextRender);
        return nextRender;
      } catch (reason: unknown) {
        setError(toApiError(reason));
        return null;
      }
    },
    [api],
  );

  useEffect(() => {
    if (!render || !LIVE_RENDER_STATES.has(render.receipt.state)) return;
    const timer = window.setInterval(() => void refreshRender(render.receipt.renderId), 1_000);
    return () => window.clearInterval(timer);
  }, [refreshRender, render]);

  const startBuild = useCallback(async () => {
    if (!api || !workspace || pending || !prompt.trim()) return;
    setPending("build");
    setError(null);
    try {
      const requestFor = (baseCommit: string) => ({
        version: "sequences.start-job.v1" as const,
        kind: "build" as const,
        prompt: prompt.trim(),
        baseCommit,
        directorMode: "reset" as const,
        ...(imagePaths.length > 0 ? { imagePaths } : {}),
      });
      let nextJob: JobResponse;
      try {
        nextJob = await api.startJob(PROJECT_ID, requestFor(workspace.project.acceptedCommit));
      } catch (reason) {
        if (!(reason instanceof ApiRequestError) || reason.code !== "stale_base") throw reason;
        const refreshed = await api.bootstrap();
        setWorkspace(refreshed);
        nextJob = await api.startJob(PROJECT_ID, requestFor(refreshed.project.acceptedCommit));
      }
      setJob(nextJob);
      setVisibleJobId(nextJob.receipt.jobId);
      launchedJobIdRef.current = nextJob.receipt.jobId;
      setImagePaths([]);
      setAttachmentsBlocked(false);
      setAttachmentBatch((value) => value + 1);
    } catch (reason: unknown) {
      setError(toApiError(reason));
    } finally {
      setPending(null);
    }
  }, [api, imagePaths, pending, prompt, workspace]);

  useEffect(() => {
    if (
      job?.receipt.state === "applied" &&
      launchedJobIdRef.current === job.receipt.jobId &&
      job.receipt.acceptedCommit === workspace?.project.acceptedCommit
    ) {
      launchedJobIdRef.current = null;
      setViewerSelection({
        kind: "composition",
        jobId: job.receipt.jobId,
        label: "Latest generated video",
      });
    }
  }, [job?.receipt.acceptedCommit, job?.receipt.jobId, job?.receipt.state, workspace]);

  const cancelJob = useCallback(async () => {
    if (!api || !job || pending) return;
    setPending("cancel");
    setError(null);
    try {
      setJob(await api.cancelJob(job.receipt.jobId));
    } catch (reason: unknown) {
      setError(toApiError(reason));
    } finally {
      setPending(null);
    }
  }, [api, job, pending]);

  const startRender = useCallback(async () => {
    if (!api || !workspace || pending) return;
    setPending("render");
    setError(null);
    try {
      setRender(
        await api.startRender(PROJECT_ID, {
          version: "sequences.start-render.v1",
          quality: "standard",
        }),
      );
    } catch (reason: unknown) {
      setError(toApiError(reason));
    } finally {
      setPending(null);
    }
  }, [api, pending, workspace]);

  const cancelRender = useCallback(async () => {
    if (!api || !render || pending || !LIVE_RENDER_STATES.has(render.receipt.state)) return;
    setPending("cancel-render");
    setError(null);
    try {
      setRender(await api.cancelRender(render.receipt.renderId));
    } catch (reason: unknown) {
      setError(toApiError(reason));
    } finally {
      setPending(null);
    }
  }, [api, pending, render]);

  if (loadState !== "ready" || !workspace) {
    return <StartupState state={loadState} error={loadError} />;
  }

  const source = revisionedSource(workspace.project.acceptedUrl, workspace.project.acceptedCommit);
  const canRun = workspace.capabilities.available;
  const generationActive = Boolean(job && LIVE_STATES.has(job.receipt.state));
  const generationInProgress = Boolean(
    pending === "build" || generationActive || job?.receipt.state === "applying",
  );
  const currentStatus = generationInProgress ? "Generating…" : "Ready";
  const acceptedRunId = workspace.project.acceptedSource.runId;
  const recentJobs = workspace.project.jobs
    .filter((recentJob) => recentJob.state === "applied")
    .slice(0, 8);
  const selectedShowcase =
    viewerSelection.kind === "showcase"
      ? (SHOWCASES.find((showcase) => showcase.id === viewerSelection.id) ?? SHOWCASES[0])
      : null;
  const selectedCompositionSource =
    viewerSelection.kind === "composition"
      ? viewerSelection.jobId === acceptedRunId || !viewerSelection.jobId
        ? source
        : candidateSource(workspace.project.acceptedUrl, viewerSelection.jobId)
      : null;
  const viewerTitle =
    viewerSelection.kind === "showcase" ? selectedShowcase!.title : viewerSelection.label;

  return (
    <div className="app">
      <header className="site-header">
        <a className="site-wordmark" href="#top" aria-label="Sequences home">
          Sequences<span>.</span>
        </a>
        <div className="site-header__status">
          <span
            className={`header-status header-status--${generationInProgress ? "attention" : "neutral"}`}
          >
            <span className="connection-dot" aria-hidden="true" />
            {currentStatus}
          </span>
          <code>{shortCommit(workspace.project.acceptedCommit)}</code>
        </div>
      </header>

      <main className="home-shell" id="top">
        <section className="hero" aria-labelledby="page-title">
          <span className="hero__kicker">AI motion direction for SaaS</span>
          <h1 id="page-title">Sequences</h1>
          <p>From one prompt to a finished launch video.</p>
        </section>

        <section ref={viewerPanelRef} className="studio-panel" aria-label="Sequences studio">
          <header className="studio-panel__header">
            <div>
              <span className="eyebrow">Now playing</span>
              <h2>{viewerTitle}</h2>
            </div>
            <div className="viewer-source" role="group" aria-label="Viewer source">
              <button
                type="button"
                className={
                  viewerSelection.kind === "showcase" &&
                  viewerSelection.id === "chatgpt-native-story"
                    ? "is-active"
                    : ""
                }
                aria-pressed={
                  viewerSelection.kind === "showcase" &&
                  viewerSelection.id === "chatgpt-native-story"
                }
                onClick={() => setViewerSelection({ kind: "showcase", id: "chatgpt-native-story" })}
              >
                Featured
              </button>
              <button
                type="button"
                className={
                  viewerSelection.kind === "composition" && viewerSelection.jobId === acceptedRunId
                    ? "is-active"
                    : ""
                }
                aria-pressed={
                  viewerSelection.kind === "composition" && viewerSelection.jobId === acceptedRunId
                }
                onClick={() =>
                  setViewerSelection({
                    kind: "composition",
                    jobId: acceptedRunId,
                    label: "Latest generated video",
                  })
                }
              >
                Latest
              </button>
            </div>
          </header>
          {selectedShowcase ? (
            <SequencesStudio
              key={selectedShowcase.id}
              mode="video"
              mediaSource={`/api/v1/showcases/${selectedShowcase.id}/video`}
              poster={`/api/v1/showcases/${selectedShowcase.id}/poster`}
              label={selectedShowcase.title}
            />
          ) : (
            <SequencesStudio
              key={viewerSelection.kind === "composition" ? viewerSelection.jobId : "latest"}
              mode="composition"
              source={selectedCompositionSource ?? source}
              label={viewerTitle}
            />
          )}
        </section>

        <section className="create-panel" aria-labelledby="create-heading">
          <div className="create-panel__heading">
            <div>
              <span className="eyebrow">Create a sequence</span>
              <h2 id="create-heading">What do you want to make?</h2>
            </div>
            <p>Describe the launch moment. Codex will direct, build, verify, and place it above.</p>
          </div>

          {!canRun ? (
            <div className="notice notice--warning" role="alert">
              <strong>Authoring is unavailable</strong>
              <span>
                {uiMessage(workspace.capabilities.unavailableReason ?? "Run bun run doctor.")}
              </span>
            </div>
          ) : null}

          <form
            className="prompt-form"
            onSubmit={(event) => {
              event.preventDefault();
              void startBuild();
            }}
          >
            <label className="sr-only" htmlFor="video-prompt">
              Prompt
            </label>
            <textarea
              ref={promptRef}
              id="video-prompt"
              value={prompt}
              rows={5}
              maxLength={16_000}
              disabled={!canRun || generationInProgress}
              placeholder="A 24-second launch film for…"
              onChange={(event) => setPrompt(event.target.value)}
            />

            <div className="prompt-form__tools">
              <ImageAttachments
                key={attachmentBatch}
                api={api!}
                projectId={PROJECT_ID}
                disabled={!canRun || generationInProgress}
                onChange={updateAttachments}
              />

              <div className="prompt-form__footer">
                {generationActive ? (
                  <button
                    className="button button--quiet-danger"
                    type="button"
                    disabled={pending !== null}
                    onClick={() => void cancelJob()}
                  >
                    {pending === "cancel" ? "Stopping…" : "Stop generation"}
                  </button>
                ) : (
                  <button
                    className="button button--primary"
                    type="submit"
                    disabled={
                      !canRun || !prompt.trim() || generationInProgress || attachmentsBlocked
                    }
                  >
                    <span>{generationInProgress ? "Finishing…" : "Generate"}</span>
                    <span aria-hidden="true">↗</span>
                  </button>
                )}
              </div>
            </div>
          </form>

          <div className="operations-grid">
            {job && visibleJobId === job.receipt.jobId ? (
              <JobCard job={job} events={jobEvents} elapsedMs={elapsedMs} />
            ) : null}

            <RenderCard
              render={render}
              acceptedCommit={workspace.project.acceptedCommit}
              pending={pending}
              onStart={() => void startRender()}
              onCancel={() => void cancelRender()}
            />
          </div>

          {error ? (
            <div className="notice notice--error" role="alert">
              <strong>Couldn’t generate the video</strong>
              <span>{uiMessage(error.message)}</span>
            </div>
          ) : null}
        </section>

        <section className="library" aria-labelledby="library-heading">
          <div className="library__heading">
            <div>
              <span className="eyebrow">Library</span>
              <h2 id="library-heading">Sequences worth watching</h2>
            </div>
            <div className="library-tabs" role="tablist" aria-label="Video library">
              <button
                type="button"
                role="tab"
                aria-selected={libraryTab === "showcase"}
                className={libraryTab === "showcase" ? "is-active" : ""}
                onClick={() => setLibraryTab("showcase")}
              >
                Showcase
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={libraryTab === "recent"}
                className={libraryTab === "recent" ? "is-active" : ""}
                onClick={() => setLibraryTab("recent")}
              >
                Recent
                <span>{recentJobs.length}</span>
              </button>
            </div>
          </div>

          {libraryTab === "showcase" ? (
            <div className="showcase-grid" role="tabpanel" aria-label="Showcase videos">
              {SHOWCASES.map((showcase, index) => (
                <button
                  type="button"
                  className={`showcase-card${
                    viewerSelection.kind === "showcase" && viewerSelection.id === showcase.id
                      ? " showcase-card--selected"
                      : ""
                  }`}
                  key={showcase.id}
                  onClick={() => showInViewer({ kind: "showcase", id: showcase.id })}
                >
                  <div className="showcase-card__media">
                    <img src={`/api/v1/showcases/${showcase.id}/poster`} alt="" loading="lazy" />
                    <span>{showcase.duration}</span>
                    <i aria-hidden="true">▶</i>
                  </div>
                  <div className="showcase-card__copy">
                    <div>
                      <span className="eyebrow">
                        {index === 0 ? "Featured sequence" : "Showcase sequence"}
                      </span>
                      <h3>{showcase.title}</h3>
                    </div>
                    <p>{showcase.description}</p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="recent-grid" role="tabpanel" aria-label="Recent videos">
              {recentJobs.length > 0 ? (
                recentJobs.map((recentJob) => (
                  <button
                    type="button"
                    className={`recent-card${
                      recentJob.id === acceptedRunId ? " recent-card--current" : ""
                    }${
                      viewerSelection.kind === "composition" &&
                      viewerSelection.jobId === recentJob.id
                        ? " recent-card--selected"
                        : ""
                    }`}
                    key={recentJob.id}
                    onClick={() =>
                      showInViewer({
                        kind: "composition",
                        jobId: recentJob.id,
                        label:
                          recentJob.id === acceptedRunId
                            ? "Latest generated video"
                            : `Generated sequence · ${formatRecentDate(recentJob.createdAt)}`,
                      })
                    }
                  >
                    <div className="recent-card__visual" aria-hidden="true">
                      <span>{recentJob.id === acceptedRunId ? "Latest" : "Sequence"}</span>
                      <strong>S</strong>
                    </div>
                    <div className="recent-card__copy">
                      <span className={`state-pill state-pill--${toneForState(recentJob.state)}`}>
                        {STATE_LABELS[recentJob.state]}
                      </span>
                      <h3>
                        {recentJob.id === acceptedRunId ? "Latest generated video" : "Recent run"}
                      </h3>
                      <p>{formatRecentDate(recentJob.createdAt)}</p>
                      <code>{recentJob.id.slice(-8)}</code>
                    </div>
                  </button>
                ))
              ) : (
                <div className="library-empty">
                  <strong>No recent sequences yet.</strong>
                  <span>Your generated videos will appear here.</span>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      <footer className="site-footer">
        <span>Sequences</span>
        <span>{workspace.project.title} · Local workspace</span>
      </footer>
    </div>
  );
}

export function JobCard({
  job,
  events,
  elapsedMs,
}: {
  job: JobResponse;
  events: readonly JobEvent[];
  elapsedMs: number | null;
}) {
  const { receipt } = job;
  const live = LIVE_STATES.has(receipt.state);
  const failed = ["failed", "timed_out", "cancelled"].includes(receipt.state);
  const phase = phaseForJob(job, events.at(-1) ?? null);

  return (
    <section
      className="job-card"
      aria-live="polite"
      data-job-id={receipt.jobId}
      data-job-outcome={
        receipt.state === "applied"
          ? "success"
          : ["failed", "timed_out", "cancelled", "stale", "rejected"].includes(receipt.state)
            ? "failure"
            : "active"
      }
    >
      <div className="job-card__header">
        <div>
          <span className="eyebrow">Latest run</span>
          <strong>{phase.title}</strong>
        </div>
        <span className={`state-pill state-pill--${toneForState(receipt.state)}`}>
          {STATE_LABELS[receipt.state]}
        </span>
      </div>

      <div className="job-phase">
        <span className={`job-phase__dot job-phase__dot--${toneForState(receipt.state)}`} />
        <div>
          <span>{live ? "Current activity" : "Result"}</span>
          <strong>{phase.detail}</strong>
        </div>
        {elapsedMs !== null ? <time>{formatElapsed(elapsedMs)}</time> : null}
      </div>

      <dl className="receipt-grid">
        <div>
          <dt>Run</dt>
          <dd title={receipt.jobId}>{receipt.jobId.slice(-8)}</dd>
        </div>
        <div>
          <dt>QA</dt>
          <dd>{receipt.qa ? (receipt.qa.ok ? "Passed" : "Failed") : "Pending"}</dd>
        </div>
        {receipt.director ? (
          <div>
            <dt>Luna</dt>
            <dd>Fresh run · gen {receipt.director.generation}</dd>
          </div>
        ) : null}
      </dl>

      {events.length > 0 ? (
        <ol className="job-activity" aria-label="Recent Luna activity">
          {events.map((event) => (
            <li key={event.sequence}>
              <span>{event.currentFile ?? event.tool ?? event.stage}</span>
              <strong>{uiMessage(event.message)}</strong>
            </li>
          ))}
        </ol>
      ) : null}

      {failed ? (
        <>
          {receipt.qa && !receipt.qa.ok ? (
            <>
              <QaFailureDetails qa={receipt.qa} />
              {receipt.layoutRepairs.length > 0 ? (
                <p className="job-card__truth">
                  Luna made {receipt.layoutRepairs.length} focused layout repair{" "}
                  {pluralize("attempt", receipt.layoutRepairs.length)} in this run; the remaining
                  cluster is still unresolved.
                </p>
              ) : null}
            </>
          ) : (
            <p>{uiMessage(receipt.error?.message ?? "The run did not produce a video.")}</p>
          )}
          {receipt.error ? (
            <p className="job-card__truth">
              Failure owner: {receipt.error.owner} · {receipt.error.code} · evidence under{" "}
              <code>data/runs/release-a/{receipt.jobId}</code>
            </p>
          ) : null}
          <p className="job-card__truth">
            The previous timeline video remains available while you try again.
          </p>
        </>
      ) : null}

      {receipt.state === "applied" ? <p>Generated video is now on the timeline.</p> : null}
    </section>
  );
}

export function QaFailureDetails({ qa }: { qa: QaReceiptV1 }) {
  const unresolvedClusters = (qa.layoutClusters ?? []).filter(
    (cluster) => cluster.status !== "declared_legible",
  );
  const layoutFindingCount = qa.findings.filter(
    (finding) =>
      finding.severity !== "info" && ["content_overlap", "text_occluded"].includes(finding.code),
  ).length;
  const clusteredLayout =
    unresolvedClusters.length > 0 &&
    unresolvedClusters.reduce((count, cluster) => count + cluster.findingCount, 0) >=
      layoutFindingCount;
  const actionable = qa.findings.filter(
    (finding) =>
      finding.severity !== "info" &&
      (!clusteredLayout || !["content_overlap", "text_occluded"].includes(finding.code)),
  );
  const blocking = actionable.filter((finding) => finding.severity === "error");
  const warnings = actionable.filter((finding) => finding.severity === "warning");
  const visible = [...blocking, ...warnings].slice(0, 5);
  const omitted = actionable.length - visible.length;
  const blockingDecisions = blocking.length + unresolvedClusters.length;

  if (actionable.length === 0 && unresolvedClusters.length === 0) {
    return (
      <div className="qa-findings" role="status">
        <strong>QA needs changes</strong>
        <p>The required check did not return itemized findings. The timeline was left unchanged.</p>
      </div>
    );
  }

  return (
    <div className="qa-findings" role="status">
      <strong>QA needs changes</strong>
      <p>
        {blockingDecisions > 0
          ? `${blockingDecisions} blocking ${pluralize("finding", blockingDecisions)} must be fixed before the video can reach the timeline.`
          : "The generated video has no blocking findings, but required checks did not pass."}
        {warnings.length > 0
          ? ` ${warnings.length} ${pluralize("warning", warnings.length)} also ${warnings.length === 1 ? "needs" : "need"} attention.`
          : ""}
      </p>
      {unresolvedClusters.length > 0 ? (
        <ol className="qa-clusters">
          {unresolvedClusters.slice(0, 3).map((cluster) => (
            <li key={cluster.id}>
              <span>{layoutClusterMessage(cluster)}</span>
              <small>{cluster.summary}</small>
            </li>
          ))}
        </ol>
      ) : null}
      {visible.length > 0 ? (
        <ol>
          {visible.map((finding) => (
            <li key={qaFindingKey(finding)}>
              <code>
                {finding.category} · {finding.sourceFile ?? "source unavailable"} ·{" "}
                {formatQaTimes(finding.times)}
              </code>
              <span>{uiMessage(finding.message)}</span>
              {finding.fixHint ? <small>{uiMessage(finding.fixHint)}</small> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {omitted > 0 ? (
        <small>{omitted} additional findings are recorded with this run.</small>
      ) : null}
    </div>
  );
}

function layoutClusterMessage(cluster: NonNullable<QaReceiptV1["layoutClusters"]>[number]): string {
  const owners = cluster.beatIds.map(titleFromStableId);
  const handoff = cluster.kind === "handoff" && owners.length > 1;
  const owner = handoff ? `${owners[0]} → ${owners[1]} handoff` : owners.join(" + ");
  return `${owner} caused one unresolved layout cluster at ${cluster.sampleTime.toFixed(3)}s, affecting ${cluster.findingCount} ${pluralize("descendant", cluster.findingCount)}.`;
}

function titleFromStableId(value: string): string {
  const words = value.replaceAll(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function RenderCard({
  render,
  acceptedCommit,
  pending,
  onStart,
  onCancel,
}: {
  render: RenderResponse | null;
  acceptedCommit: string;
  pending: PendingAction;
  onStart: () => void;
  onCancel: () => void;
}) {
  const receipt = render?.receipt ?? null;
  const live = receipt ? LIVE_RENDER_STATES.has(receipt.state) : false;
  const current = receipt?.acceptedCommit === acceptedCommit;
  const completed = receipt?.state === "completed" && receipt.artifacts;

  return (
    <section className="job-card delivery-card" aria-live="polite">
      <div className="job-card__header">
        <div>
          <span className="eyebrow">Delivery</span>
          <strong>
            {receipt ? uiMessage(receipt.progress.message) : "Render the current timeline video"}
          </strong>
        </div>
        {receipt ? (
          <span className={`state-pill state-pill--${toneForRender(receipt.state)}`}>
            {receipt.state}
          </span>
        ) : null}
      </div>

      {receipt ? (
        <dl className="receipt-grid">
          <div>
            <dt>Render</dt>
            <dd title={receipt.renderId}>{receipt.renderId.slice(-8)}</dd>
          </div>
          <div>
            <dt>Commit</dt>
            <dd>{shortCommit(receipt.acceptedCommit)}</dd>
          </div>
          <div>
            <dt>Quality</dt>
            <dd>{receipt.quality}</dd>
          </div>
          <div>
            <dt>Progress</dt>
            <dd>{receipt.progress.percent}%</dd>
          </div>
        </dl>
      ) : (
        <p>Rendering is human-triggered and uses an immutable snapshot of the current video.</p>
      )}

      {live ? (
        <button
          className="button button--quiet-danger"
          type="button"
          disabled={pending !== null || receipt?.cancelRequested}
          onClick={onCancel}
        >
          {pending === "cancel-render" || receipt?.cancelRequested
            ? "Cancelling…"
            : "Cancel render"}
        </button>
      ) : null}

      {completed ? (
        <div className="delivery-artifacts">
          <p>
            {completed.video.codec.toUpperCase()} · {completed.video.width} ×{" "}
            {completed.video.height} · {completed.video.durationSeconds.toFixed(1)}s ·{" "}
            {formatBytes(completed.video.bytes)}
            {completed.audio
              ? ` · ♪ ${completed.audio.soundtrackId} + ${completed.audio.cueCount} cue${completed.audio.cueCount === 1 ? "" : "s"}`
              : " · silent"}
          </p>
          <code>{completed.video.path}</code>
          <code>{completed.sourceBundle.path}</code>
          <div className="job-card__actions">
            <a className="button button--primary" href={completed.video.downloadUrl} download>
              Download MP4
            </a>
            <a className="button" href={completed.sourceBundle.downloadUrl} download>
              Download source
            </a>
          </div>
        </div>
      ) : null}

      {receipt?.state === "failed" ? (
        <p>{uiMessage(receipt.error?.message ?? "Render failed.")}</p>
      ) : null}
      {receipt?.state === "cancelled" ? <p>No partial output is offered for download.</p> : null}
      {receipt && !current ? <p>This receipt belongs to a previous timeline version.</p> : null}

      {!live && (!completed || !current) ? (
        <button
          className="button button--primary"
          type="button"
          disabled={pending !== null}
          onClick={onStart}
        >
          {pending === "render" ? "Starting…" : "Render MP4"}
        </button>
      ) : null}
    </section>
  );
}

function StartupState({ state, error }: { state: LoadState; error: Error | null }) {
  return (
    <main className="startup-state">
      <span className="brand__mark" aria-hidden="true">
        S
      </span>
      <span className="eyebrow">Sequences</span>
      <h1>{state === "error" ? "Could not start" : "Loading workspace"}</h1>
      <p>
        {uiMessage(
          error?.message ??
            "Connecting to the local project and checking its local authoring tools…",
        )}
      </p>
      {state === "error" ? (
        <button
          className="button button--primary"
          type="button"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      ) : null}
    </main>
  );
}

async function initializeWorkspace(): Promise<{
  api: SequencesApi;
  workspace: WorkspaceBootstrap;
}> {
  const url = new URL(window.location.href);
  const bootToken = url.searchParams.get("boot");
  const api = bootToken ? await SequencesApi.establish(bootToken) : SequencesApi.restore();
  if (!api) throw new MissingLocalSessionError();

  if (bootToken) {
    url.searchParams.delete("boot");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return { api, workspace: await api.bootstrap() };
}

function toApiError(reason: unknown): ApiRequestError {
  return reason instanceof ApiRequestError
    ? reason
    : new ApiRequestError(reason instanceof Error ? reason.message : "The local request failed.");
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

function revisionedSource(source: string, revision: string): string {
  const separator = source.includes("?") ? "&" : "?";
  return `${source}${separator}revision=${encodeURIComponent(revision)}`;
}

function candidateSource(acceptedUrl: string, jobId: string): string {
  const candidateUrl = acceptedUrl.replace(
    /\/accepted\/index\.html(?:\?.*)?$/,
    `/candidate/${encodeURIComponent(jobId)}/index.html`,
  );
  return revisionedSource(candidateUrl, jobId);
}

function phaseForJob(
  job: JobResponse | null,
  latestEvent: JobEvent | null,
): { title: string; detail: string } {
  if (!job) return { title: "Ready to create", detail: "Write a brief to start a new video." };
  if (job.receipt.state === "failed" && job.receipt.qa && !job.receipt.qa.ok) {
    return {
      title: "QA needs changes",
      detail: "Required checks found changes to make before the timeline can update.",
    };
  }
  const fallback: Record<JobState, { title: string; detail: string }> = {
    queued: { title: "Queued", detail: "Waiting for Luna to start." },
    preparing: { title: "Preparing workspace", detail: "Creating a fresh video workspace." },
    authoring: { title: "Building your video", detail: "Luna is creating the video source." },
    verifying: { title: "Checking your video", detail: "Running the required local checks." },
    review_ready: {
      title: "Finalizing video",
      detail: "QA passed; putting the generated video on the timeline.",
    },
    applying: { title: "Finalizing video", detail: "Putting the generated video on the timeline." },
    applied: { title: "Complete", detail: "Generated video is ready on the timeline." },
    rejected: { title: "Discarded", detail: "The generated video was discarded." },
    stale: { title: "Superseded", detail: "This generation was superseded; generate again." },
    failed: { title: "Run failed", detail: "No new video reached the timeline." },
    timed_out: { title: "Run timed out", detail: "The authoring time limit was reached." },
    cancelled: { title: "Run cancelled", detail: "The previous timeline video remains available." },
  };
  const phase = fallback[job.receipt.state];
  return {
    title: phase.title,
    detail:
      latestEvent?.jobId === job.receipt.jobId ? uiMessage(latestEvent.message) : phase.detail,
  };
}

function useElapsedTime(job: JobResponse | null): number | null {
  const active = Boolean(
    job && (LIVE_STATES.has(job.receipt.state) || job.receipt.state === "applying"),
  );
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, job?.receipt.jobId]);

  if (!job) return null;
  const start = Date.parse(job.receipt.createdAt);
  const end = active ? now : Date.parse(job.receipt.finishedAt ?? job.receipt.updatedAt);
  return Math.max(0, end - start);
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatRecentDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently created";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatQaTimes(times: readonly number[]): string {
  if (times.length === 0) return "sample time unavailable";
  return times.map((time) => `${time.toFixed(2)}s`).join(", ");
}

function qaFindingKey(finding: QaReceiptV1["findings"][number]): string {
  return [
    finding.command,
    finding.category,
    finding.code,
    finding.sourceFile ?? "",
    finding.selector ?? "",
    finding.message,
  ].join(":");
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function uiMessage(value: string): string {
  return value.replace(/hyperframes/gi, "video engine");
}

function toneForState(state: JobState): "neutral" | "attention" | "danger" | "pass" {
  if (["failed", "timed_out"].includes(state)) return "danger";
  if (["review_ready", "verifying", "stale"].includes(state)) return "attention";
  if (["applied"].includes(state)) return "pass";
  return "neutral";
}

function toneForRender(state: RenderState): "neutral" | "attention" | "danger" | "pass" {
  if (state === "failed") return "danger";
  if (["rendering", "verifying"].includes(state)) return "attention";
  if (state === "completed") return "pass";
  return "neutral";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024 * 1_024) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
