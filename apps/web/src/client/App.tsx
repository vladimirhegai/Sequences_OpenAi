import {
  ArrowRight,
  ArrowSquareOut,
  Check,
  Circle,
  Clock,
  FilmSlate,
  GitBranch,
  PaperPlaneRight,
  SealCheck,
  ShieldCheck,
  StopCircle,
  TerminalWindow,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JobState, RunReceiptV1 } from "../shared";
import {
  ApiRequestError,
  MissingLocalSessionError,
  SequencesApi,
  type JobEvent,
  type JobResponse,
  type WorkspaceBootstrap,
} from "./api";
import { HyperframesViewer } from "./HyperframesViewer";

const PROJECT_ID = "release-a";
const STUDIO_URL = "http://127.0.0.1:5190/#project/release-a";
const BRIEF_STORAGE_KEY = "sequences.release-a.brief";

type Route =
  | { mode: "create" }
  | { mode: "editor" }
  | { mode: "review"; jobId: string }
  | { mode: "sample" };

type LoadState = "loading" | "ready" | "error";
type ConnectionState = "idle" | "connecting" | "live" | "reconnecting";
type ConfirmAction = "cancel" | "apply" | "reject";

interface ToastState {
  title: string;
  detail: string;
}

const LIVE_STATES = new Set<JobState>([
  "queued",
  "preparing",
  "authoring",
  "verifying",
  "applying",
]);

const STATE_LABELS: Record<JobState, string> = {
  queued: "Queued",
  preparing: "Preparing",
  authoring: "Authoring",
  verifying: "Verifying",
  review_ready: "Review ready",
  applying: "Applying",
  applied: "Applied",
  rejected: "Rejected",
  stale: "Stale base",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
};

export function App() {
  const [route, setRoute] = useState<Route>(() => routeFromLocation());
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [api, setApi] = useState<SequencesApi | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceBootstrap | null>(null);
  const [activeJob, setActiveJob] = useState<JobResponse | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [brief, setBrief] = useState(() => sessionStorage.getItem(BRIEF_STORAGE_KEY) ?? "");
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiRequestError | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const startupRef = useRef<Promise<{ api: SequencesApi; workspace: WorkspaceBootstrap }> | null>(
    null,
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const navigate = useCallback((next: Route, replace = false) => {
    const path = pathForRoute(next);
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
    setRoute(next);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let disposed = false;
    startupRef.current ??= initializeWorkspace();

    void startupRef.current
      .then(async (result) => {
        if (disposed) return;
        setApi(result.api);
        setWorkspace(result.workspace);

        const lastJob = result.workspace.project.jobs.at(-1);
        if (lastJob) {
          try {
            const response = await result.api.getJob(lastJob.id);
            if (!disposed) setActiveJob(response);
          } catch {
            // The project remains usable even if an old receipt was removed.
          }
        }
        if (!disposed) setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setLoadError(error instanceof Error ? error : new Error("Sequences failed to start."));
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
        const response = await api.getJob(jobId);
        setActiveJob(response);
        return response;
      } catch (error) {
        if (error instanceof ApiRequestError) setActionError(error);
        return null;
      }
    },
    [api],
  );

  useEffect(() => {
    if (route.mode !== "review" || !api || activeJob?.receipt.jobId === route.jobId) return;
    void refreshJob(route.jobId);
  }, [activeJob?.receipt.jobId, api, refreshJob, route]);

  useEffect(() => {
    if (!api || !activeJob || !LIVE_STATES.has(activeJob.receipt.state)) {
      setConnection("idle");
      return;
    }

    const { jobId } = activeJob.receipt;
    let disposed = false;
    setConnection("connecting");

    const unsubscribe = api.subscribeToJob(
      activeJob.eventsUrl,
      (event) => {
        if (disposed || event.jobId !== jobId) return;
        setConnection("live");
        setEvents((current) => mergeJobEvent(current, event));
        if (event.state !== activeJob.receipt.state || event.state === "review_ready") {
          void refreshJob(jobId);
        }
      },
      () => {
        if (!disposed) setConnection("reconnecting");
      },
    );

    const poll = window.setInterval(() => {
      void refreshJob(jobId);
    }, 3_000);

    return () => {
      disposed = true;
      unsubscribe();
      window.clearInterval(poll);
    };
  }, [activeJob, api, refreshJob]);

  useEffect(() => {
    if (
      route.mode === "create" &&
      activeJob?.receipt.state === "review_ready" &&
      activeJob.receipt.kind !== "plan"
    ) {
      navigate({ mode: "review", jobId: activeJob.receipt.jobId });
      setToast({
        title: "Candidate ready",
        detail:
          "Independent Hyperframes verification finished. Review the real composition before applying it.",
      });
    }
  }, [activeJob, navigate, route.mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (route.mode === "editor") return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        composerRef.current?.focus();
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "Enter" &&
        document.activeElement === composerRef.current
      ) {
        event.preventDefault();
        composerRef.current?.form?.requestSubmit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [route.mode]);

  const startJob = useCallback(
    async (kind: "plan" | "build", prompt: string) => {
      if (!api || !workspace || actionPending) return;
      setActionPending(kind);
      setActionError(null);
      setEvents([]);
      try {
        const response = await api.startJob(PROJECT_ID, {
          version: "sequences.start-job.v1",
          kind,
          prompt,
          baseCommit: workspace.project.acceptedCommit,
        });
        setActiveJob(response);
        navigate({ mode: "create" });
      } catch (error) {
        setActionError(toApiError(error));
      } finally {
        setActionPending(null);
      }
    },
    [actionPending, api, navigate, workspace],
  );

  const submitPlan = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      const prompt = brief.trim();
      if (!prompt) {
        composerRef.current?.focus();
        return;
      }
      sessionStorage.setItem(BRIEF_STORAGE_KEY, prompt);
      void startJob("plan", prompt);
    },
    [brief, startJob],
  );

  const approvePlanAndBuild = useCallback(() => {
    const plan = activeJob?.receipt;
    if (!plan || plan.kind !== "plan" || plan.state !== "review_ready" || !plan.final) return;
    const buildPrompt = [
      "Build the approved Hyperframes product sequence. Preserve the accepted plan and follow the pinned project-local skills.",
      `Original brief:\n${brief.trim()}`,
      `Approved planning intent:\n${plan.final.intent}`,
      plan.final.limitations.length > 0
        ? `Known limitations to preserve or resolve explicitly:\n- ${plan.final.limitations.join("\n- ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 16_000);
    void startJob("build", buildPrompt);
  }, [activeJob, brief, startJob]);

  const retryAsNewRun = useCallback(() => {
    if (!activeJob) return;
    if (activeJob.receipt.kind === "plan") {
      void startJob("plan", brief.trim());
      return;
    }
    const retryPrompt = [
      "Retry this previously approved Hyperframes build as a new isolated candidate. Re-evaluate the failure before editing.",
      `Original brief:\n${brief.trim()}`,
      activeJob.receipt.error ? `Previous owned failure:\n${activeJob.receipt.error.message}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 16_000);
    void startJob("build", retryPrompt);
  }, [activeJob, brief, startJob]);

  const runConfirmedAction = useCallback(async () => {
    if (!api || !activeJob || !confirmAction || actionPending) return;
    const action = confirmAction;
    setActionPending(action);
    setActionError(null);
    try {
      const response = await api.actOnJob(
        activeJob.receipt.jobId,
        action,
        action === "reject"
          ? rejectReason.trim() || "Rejected during candidate review."
          : undefined,
      );
      setActiveJob(response);
      setConfirmAction(null);
      setRejectReason("");

      if (action === "cancel") {
        setToast({
          title: "Run cancelled",
          detail: "The partial candidate remains isolated from accepted source.",
        });
      } else if (action === "reject") {
        setToast({ title: "Candidate rejected", detail: "Accepted source was not changed." });
      } else {
        const refreshed = await api.bootstrap();
        setWorkspace(refreshed);
        setToast({
          title: "Candidate applied",
          detail: "Accepted source advanced to the verified candidate commit.",
        });
      }
    } catch (error) {
      setConfirmAction(null);
      setActionError(toApiError(error));
      if (error instanceof ApiRequestError && error.code === "stale_base") {
        void refreshJob(activeJob.receipt.jobId);
      }
    } finally {
      setActionPending(null);
    }
  }, [activeJob, actionPending, api, confirmAction, refreshJob, rejectReason]);

  if (loadState !== "ready" || !workspace) {
    return <StartupState state={loadState} error={loadError} />;
  }

  const job = activeJob;
  const canRun = workspace.capabilities.available;

  return (
    <div className={`app app--${route.mode}`}>
      <TopBar route={route} workspace={workspace} job={job} onNavigate={navigate} />

      {route.mode === "create" ? (
        <CreateMode
          workspace={workspace}
          job={job}
          events={events}
          connection={connection}
          brief={brief}
          canRun={canRun}
          actionPending={actionPending}
          actionError={actionError}
          composerRef={composerRef}
          onBriefChange={setBrief}
          onSubmitPlan={submitPlan}
          onApproveBuild={approvePlanAndBuild}
          onCancel={() => setConfirmAction("cancel")}
          onRetry={retryAsNewRun}
          onOpenReview={(jobId) => navigate({ mode: "review", jobId })}
          onOpenSample={() => navigate({ mode: "sample" })}
        />
      ) : null}

      {route.mode === "editor" ? <EditorMode acceptedUrl={workspace.project.acceptedUrl} /> : null}

      {route.mode === "review" ? (
        <ReviewMode
          workspace={workspace}
          job={job?.receipt.jobId === route.jobId ? job : null}
          actionPending={actionPending}
          actionError={actionError}
          onApply={() => setConfirmAction("apply")}
          onReject={() => setConfirmAction("reject")}
          onOpenStudio={() => navigate({ mode: "editor" })}
          onReturn={() => navigate({ mode: "create" })}
        />
      ) : null}

      {route.mode === "sample" ? (
        <SampleMode workspace={workspace} onReturn={() => navigate({ mode: "create" })} />
      ) : null}

      {confirmAction && activeJob ? (
        <DecisionDialog
          action={confirmAction}
          receipt={activeJob.receipt}
          reason={rejectReason}
          pending={actionPending === confirmAction}
          onReasonChange={setRejectReason}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => void runConfirmedAction()}
        />
      ) : null}

      {toast ? <Toast toast={toast} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}

interface TopBarProps {
  route: Route;
  workspace: WorkspaceBootstrap;
  job: JobResponse | null;
  onNavigate: (route: Route) => void;
}

function TopBar({ route, workspace, job, onNavigate }: TopBarProps) {
  const currentStep = workflowStep(job?.receipt ?? null);
  const reviewable = job?.receipt.kind !== "plan" && job?.receipt.state === "review_ready";
  const status = job ? STATE_LABELS[job.receipt.state] : "Ready";

  return (
    <header className="topbar">
      <button className="brand" type="button" onClick={() => onNavigate({ mode: "create" })}>
        <span className="brand__mark" aria-hidden="true">
          S
        </span>
        <span className="brand__text">
          <strong>Sequences</strong>
          <span>{workspace.project.title}</span>
        </span>
        <code title={workspace.project.acceptedCommit}>
          {shortCommit(workspace.project.acceptedCommit)}
        </code>
      </button>

      <nav className="workflow" aria-label="Sequence workflow">
        {(["Plan", "Build", "Verify", "Review"] as const).map((label, index) => (
          <span
            key={label}
            className={`workflow__step ${index < currentStep ? "is-complete" : ""} ${index === currentStep ? "is-current" : ""}`}
            aria-current={index === currentStep ? "step" : undefined}
          >
            {index < currentStep ? <Check weight="bold" aria-hidden="true" /> : null}
            {label}
          </span>
        ))}
      </nav>

      <nav className="topbar__actions" aria-label="Project views">
        <span className={`job-status job-status--${statusTone(job?.receipt.state)}`}>
          <span aria-hidden="true" />
          {status}
        </span>
        {route.mode !== "create" ? (
          <button
            type="button"
            className="text-button"
            onClick={() => onNavigate({ mode: "create" })}
          >
            Create
          </button>
        ) : null}
        {reviewable && route.mode !== "review" ? (
          <button
            type="button"
            className="text-button"
            onClick={() => onNavigate({ mode: "review", jobId: job.receipt.jobId })}
          >
            Review
          </button>
        ) : null}
        {route.mode !== "editor" ? (
          <button
            type="button"
            className="button button--compact"
            onClick={() => onNavigate({ mode: "editor" })}
          >
            <FilmSlate aria-hidden="true" />
            Studio
          </button>
        ) : (
          <a className="button button--compact" href={STUDIO_URL} target="_blank" rel="noreferrer">
            New window
            <ArrowSquareOut aria-hidden="true" />
          </a>
        )}
      </nav>
    </header>
  );
}

interface CreateModeProps {
  workspace: WorkspaceBootstrap;
  job: JobResponse | null;
  events: JobEvent[];
  connection: ConnectionState;
  brief: string;
  canRun: boolean;
  actionPending: string | null;
  actionError: ApiRequestError | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onBriefChange: (value: string) => void;
  onSubmitPlan: (event: FormEvent) => void;
  onApproveBuild: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onOpenReview: (jobId: string) => void;
  onOpenSample: () => void;
}

function CreateMode({
  workspace,
  job,
  events,
  connection,
  brief,
  canRun,
  actionPending,
  actionError,
  composerRef,
  onBriefChange,
  onSubmitPlan,
  onApproveBuild,
  onCancel,
  onRetry,
  onOpenReview,
  onOpenSample,
}: CreateModeProps) {
  const receipt = job?.receipt ?? null;
  const live = receipt ? LIVE_STATES.has(receipt.state) : false;
  const planReady = receipt?.kind === "plan" && receipt.state === "review_ready";
  const candidateReady = receipt?.kind !== "plan" && receipt?.state === "review_ready";
  const failed = receipt && ["failed", "timed_out", "cancelled", "stale"].includes(receipt.state);
  const showComposer = !live && !planReady && !candidateReady;

  return (
    <main className="create-canvas">
      <section className="create-desk" aria-label="Codex authoring conversation">
        <header className="create-intro">
          <span className="eyebrow">Create sequence</span>
          <h1>Turn product evidence into a sequence</h1>
          <p>
            Plan with Codex, author a real Hyperframes candidate, verify it independently, then
            decide what becomes accepted.
          </p>
        </header>

        {!canRun ? (
          <StatePanel
            tone="amber"
            icon={<WarningCircle />}
            title="Authoring dependency unavailable"
            live="assertive"
          >
            <p>
              {workspace.capabilities.unavailableReason ??
                "The pinned Hyperframes capability bundle is unavailable."}
            </p>
            <p className="state-panel__meta">
              Run <code>bun run doctor</code> in the project terminal, then reload this page.
            </p>
          </StatePanel>
        ) : null}

        {brief.trim() && receipt ? (
          <article className="transcript-entry transcript-entry--user">
            <header>
              <span>Your brief</span>
              <time>{formatClock(receipt.createdAt)}</time>
            </header>
            <p>{brief.trim()}</p>
          </article>
        ) : null}

        {receipt ? (
          <JobLedger receipt={receipt} events={events} connection={connection} />
        ) : (
          <div className="empty-prompt" aria-hidden="true">
            <span className="empty-prompt__rule" />
            <span>Start with the release story, proof points, and audience.</span>
          </div>
        )}

        {planReady ? (
          <PlanResult
            receipt={receipt}
            pending={actionPending === "build"}
            onApprove={onApproveBuild}
          />
        ) : null}

        {candidateReady ? (
          <StatePanel
            tone="green"
            icon={<SealCheck />}
            title="Candidate passed the verification gate"
            live="polite"
          >
            <p>The accepted source is unchanged until you inspect and apply this candidate.</p>
            <button className="button" type="button" onClick={() => onOpenReview(receipt.jobId)}>
              Review candidate
              <ArrowRight aria-hidden="true" />
            </button>
          </StatePanel>
        ) : null}

        {failed ? <TerminalJobState receipt={receipt} onRetry={onRetry} /> : null}

        {actionError ? <InlineRequestError error={actionError} /> : null}

        {live && receipt ? (
          <div className="job-actions">
            <button className="button button--danger-quiet" type="button" onClick={onCancel}>
              <StopCircle aria-hidden="true" />
              Cancel job
            </button>
            <code>{receipt.jobId}</code>
          </div>
        ) : null}

        {showComposer ? (
          <form className="composer" onSubmit={onSubmitPlan}>
            <label className="sr-only" htmlFor="sequence-brief">
              Describe the release story
            </label>
            <textarea
              ref={composerRef}
              id="sequence-brief"
              value={brief}
              maxLength={16_000}
              rows={4}
              disabled={!canRun || actionPending !== null}
              placeholder="Describe the release story you want to make…"
              onChange={(event) => onBriefChange(event.target.value)}
            />
            <footer className="composer__footer">
              <div>
                <TerminalWindow aria-hidden="true" />
                <span>Codex · Luna high</span>
                <kbd>Ctrl ↵</kbd>
              </div>
              <button
                className="button button--primary"
                type="submit"
                disabled={!canRun || !brief.trim() || actionPending !== null}
              >
                {actionPending === "plan" ? "Starting…" : "Plan sequence"}
                <PaperPlaneRight aria-hidden="true" />
              </button>
            </footer>
          </form>
        ) : null}

        {!receipt ? (
          <footer className="create-footer">
            <button className="text-button" type="button" onClick={onOpenSample}>
              View immutable sample
              <ArrowRight aria-hidden="true" />
            </button>
            <span>Hyperframes {workspace.capabilities.hyperframesVersion}</span>
          </footer>
        ) : null}
      </section>
    </main>
  );
}

function JobLedger({
  receipt,
  events,
  connection,
}: {
  receipt: RunReceiptV1;
  events: JobEvent[];
  connection: ConnectionState;
}) {
  const elapsed = useElapsed(receipt);
  const stages = useMemo(() => buildStageRows(receipt, events), [events, receipt]);

  return (
    <article className="job-ledger" aria-live="polite" aria-label="Codex job progress">
      <header className="job-ledger__header">
        <div>
          <span className="eyebrow">{receipt.kind} run</span>
          <strong>{STATE_LABELS[receipt.state]}</strong>
        </div>
        <div className="job-ledger__time">
          <Clock aria-hidden="true" />
          <span>{formatDuration(elapsed)}</span>
          {connection !== "idle" ? (
            <span className={`connection connection--${connection}`}>
              {connection === "live"
                ? "Live"
                : connection === "reconnecting"
                  ? "Reconnecting"
                  : "Connecting"}
            </span>
          ) : null}
        </div>
      </header>
      <ol className="stage-list">
        {stages.map((stage) => (
          <li key={stage.key} className={`stage stage--${stage.status}`}>
            <span className="stage__marker" aria-hidden="true">
              {stage.status === "complete" ? <Check weight="bold" /> : null}
              {stage.status === "failed" ? <X weight="bold" /> : null}
              {stage.status === "current" || stage.status === "pending" ? (
                <Circle weight="fill" />
              ) : null}
            </span>
            <div className="stage__content">
              <div className="stage__title">
                <strong>{stage.label}</strong>
                {stage.elapsedMs !== null ? <span>{formatDuration(stage.elapsedMs)}</span> : null}
              </div>
              <p>{stage.message}</p>
              {stage.context ? <code>{stage.context}</code> : null}
              {stage.status === "current" ? <span className="stage__activity" /> : null}
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}

function PlanResult({
  receipt,
  pending,
  onApprove,
}: {
  receipt: RunReceiptV1;
  pending: boolean;
  onApprove: () => void;
}) {
  if (!receipt.final) {
    return (
      <StatePanel
        tone="amber"
        icon={<WarningCircle />}
        title="Planning record is incomplete"
        live="assertive"
      >
        <p>
          The run reached review without its typed Codex result. Build remains disabled to preserve
          the approval boundary.
        </p>
      </StatePanel>
    );
  }

  return (
    <article className="plan-result">
      <header>
        <div>
          <span className="eyebrow">Decision required</span>
          <h2>Review the planning result</h2>
        </div>
        <span className="status-tag status-tag--attention">Waiting for approval</span>
      </header>
      <section>
        <h3>Creative intent</h3>
        <p>{receipt.final.intent}</p>
      </section>
      <div className="plan-result__grid">
        <section>
          <h3>Planned artifacts</h3>
          {receipt.final.artifacts.length ? (
            <ul className="compact-list">
              {receipt.final.artifacts.map((artifact) => (
                <li key={artifact}>
                  <code>{artifact}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No artifact paths were declared.</p>
          )}
        </section>
        <section>
          <h3>Pinned skills</h3>
          {receipt.final.skillsUsed.length ? (
            <ul className="compact-list">
              {receipt.final.skillsUsed.map((skill) => (
                <li key={skill}>{skill}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No skill usage was declared.</p>
          )}
        </section>
      </div>
      {receipt.final.limitations.length ? (
        <section>
          <h3>Known omissions</h3>
          <ul className="compact-list">
            {receipt.final.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <footer>
        <span>Accepted source remains unchanged during Build.</span>
        <button
          className="button button--primary"
          type="button"
          disabled={pending}
          onClick={onApprove}
        >
          {pending ? "Starting Build…" : "Approve plan and Build"}
          <ArrowRight aria-hidden="true" />
        </button>
      </footer>
    </article>
  );
}

function TerminalJobState({ receipt, onRetry }: { receipt: RunReceiptV1; onRetry: () => void }) {
  const tone =
    receipt.state === "failed"
      ? "red"
      : receipt.state === "timed_out" || receipt.state === "stale"
        ? "amber"
        : "neutral";
  const title = STATE_LABELS[receipt.state];
  const detail =
    receipt.error?.message ??
    (receipt.state === "cancelled"
      ? "The job stopped by request. Partial files remain isolated from accepted source."
      : "This candidate cannot be promoted in its current state.");

  return (
    <StatePanel
      tone={tone}
      icon={tone === "red" ? <XCircle /> : <WarningCircle />}
      title={title}
      live="assertive"
    >
      <p>{detail}</p>
      <p className="state-panel__meta">
        <code>{receipt.jobId}</code>
        {receipt.error ? ` · owner: ${receipt.error.owner}` : ""}
      </p>
      {receipt.state !== "stale" ? (
        <button className="button" type="button" onClick={onRetry}>
          Retry as new run
        </button>
      ) : null}
    </StatePanel>
  );
}

function EditorMode({ acceptedUrl }: { acceptedUrl: string }) {
  return (
    <main className="editor-mode">
      <iframe className="studio-frame" src={STUDIO_URL} title="Official Hyperframes Studio" />
      <section className="studio-mobile-guard">
        <span className="eyebrow">Read-only preview</span>
        <h1>Open the full Studio on a desktop viewport</h1>
        <p>
          The official timeline and inspector are intentionally not compressed into a miniature
          mobile editor.
        </p>
        <HyperframesViewer
          label="Accepted Hyperframes composition"
          source={acceptedUrl}
          badge="Accepted"
        />
        <a className="button button--primary" href={STUDIO_URL} target="_blank" rel="noreferrer">
          Open full Studio <ArrowSquareOut aria-hidden="true" />
        </a>
      </section>
    </main>
  );
}

interface ReviewModeProps {
  workspace: WorkspaceBootstrap;
  job: JobResponse | null;
  actionPending: string | null;
  actionError: ApiRequestError | null;
  onApply: () => void;
  onReject: () => void;
  onOpenStudio: () => void;
  onReturn: () => void;
}

function ReviewMode({
  workspace,
  job,
  actionPending,
  actionError,
  onApply,
  onReject,
  onOpenStudio,
  onReturn,
}: ReviewModeProps) {
  if (!job) {
    return (
      <main className="route-empty">
        <GitBranch aria-hidden="true" />
        <h1>Candidate not found</h1>
        <p>Select a review-ready run from the Create workspace.</p>
        <button className="button" type="button" onClick={onReturn}>
          Return to Create
        </button>
      </main>
    );
  }

  const { receipt } = job;
  const qaPassed = receipt.qa?.ok === true;
  const reviewReady = receipt.state === "review_ready";
  const canApply = reviewReady && qaPassed;

  return (
    <main className="review-mode">
      <header className="review-header">
        <div>
          <span className="eyebrow">Candidate review</span>
          <h1>Compare before accepted source changes</h1>
        </div>
        <div className="review-header__meta">
          <span className={`status-tag status-tag--${statusTone(receipt.state)}`}>
            {STATE_LABELS[receipt.state]}
          </span>
          <code>{receipt.jobId}</code>
        </div>
      </header>

      {receipt.state === "stale" ? (
        <StatePanel
          tone="amber"
          icon={<WarningCircle />}
          title="Candidate base is stale"
          live="assertive"
        >
          <p>
            Accepted source no longer matches <code>{shortCommit(receipt.baseCommit)}</code>. Apply
            is blocked; create a new candidate from the current commit.
          </p>
        </StatePanel>
      ) : null}
      {receipt.qa && !receipt.qa.ok ? (
        <StatePanel
          tone="red"
          icon={<XCircle />}
          title="A hard verification gate failed"
          live="assertive"
        >
          <p>
            Apply remains disabled. Inspect the owned Hyperframes command failures in the QA record.
          </p>
        </StatePanel>
      ) : null}
      {actionError ? <InlineRequestError error={actionError} /> : null}

      <div className="review-grid">
        <section className="review-players" aria-label="Accepted and candidate comparison">
          <HyperframesViewer
            label="Accepted Hyperframes composition"
            source={workspace.project.acceptedUrl}
            badge="Accepted"
          />
          <HyperframesViewer
            label="Candidate Hyperframes composition"
            source={job.candidateUrl}
            badge="Candidate"
          />
        </section>

        <aside className="review-panel" aria-label="Candidate details and verification">
          <section className="candidate-facts">
            <h2>Candidate</h2>
            <dl>
              <div>
                <dt>Base</dt>
                <dd>
                  <code>{shortCommit(receipt.baseCommit)}</code>
                </dd>
              </div>
              <div>
                <dt>Candidate</dt>
                <dd>
                  <code>
                    {receipt.candidateCommit ? shortCommit(receipt.candidateCommit) : "Pending"}
                  </code>
                </dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>
                  {receipt.model} · {receipt.reasoningEffort}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(receipt.createdAt)}</dd>
              </div>
            </dl>
          </section>

          {receipt.final ? (
            <section>
              <h2>Semantic summary</h2>
              <p>{receipt.final.intent}</p>
              {receipt.final.limitations.length ? (
                <ul className="finding-list finding-list--advisory">
                  {receipt.final.limitations.map((item) => (
                    <li key={item}>
                      <WarningCircle aria-hidden="true" />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          <section>
            <h2>Source scope</h2>
            {receipt.changedFiles.length ? (
              <ul className="file-list">
                {receipt.changedFiles.map((file) => (
                  <li key={file}>
                    <Check aria-hidden="true" />
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No changed files were recorded.</p>
            )}
            <p className="scope-note">
              <ShieldCheck aria-hidden="true" /> Changed paths passed the host allowlist before
              review.
            </p>
          </section>

          <section>
            <h2>Verification gates</h2>
            {receipt.qa ? (
              <ul className="qa-list">
                {receipt.qa.commands.map((command) => (
                  <li key={command.command} className={command.ok ? "is-pass" : "is-fail"}>
                    {command.ok ? <SealCheck aria-hidden="true" /> : <XCircle aria-hidden="true" />}
                    <div>
                      <strong>Hyperframes {command.command}</strong>
                      <span>
                        {command.ok ? "Passed" : "Failed"} · {formatDuration(command.durationMs)}
                      </span>
                      {command.error ? <p>{command.error}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="verification-pending">
                <Clock aria-hidden="true" /> Verification record unavailable. Apply is disabled.
              </p>
            )}
          </section>

          <footer className="review-actions">
            <button className="button" type="button" onClick={onOpenStudio}>
              <FilmSlate aria-hidden="true" /> Open accepted in Studio
            </button>
            <div>
              <button
                className="button button--danger-quiet"
                type="button"
                disabled={!reviewReady || actionPending !== null}
                onClick={onReject}
              >
                Reject
              </button>
              <button
                className="button button--primary"
                type="button"
                disabled={!canApply || actionPending !== null}
                onClick={onApply}
              >
                Apply candidate
              </button>
            </div>
          </footer>
        </aside>
      </div>
    </main>
  );
}

function SampleMode({
  workspace,
  onReturn,
}: {
  workspace: WorkspaceBootstrap;
  onReturn: () => void;
}) {
  return (
    <main className="sample-mode">
      <header className="sample-header">
        <div>
          <span className="eyebrow">Immutable sample</span>
          <h1>The prepared Hyperframes foundation</h1>
          <p>
            This read-only fixture remains separate from live candidates and accepted project
            history.
          </p>
        </div>
        <span className="status-tag status-tag--neutral">Immutable sample</span>
      </header>
      <div className="sample-grid">
        <HyperframesViewer
          label="Immutable sample Hyperframes composition"
          source={workspace.sampleUrl}
          badge="Immutable sample"
        />
        <aside className="sample-notes">
          <ShieldCheck aria-hidden="true" />
          <h2>Safe to inspect</h2>
          <p>
            The sample URL resolves the checked-in fixture through a read-only capability. Live
            model jobs and Apply are unavailable here.
          </p>
          <dl>
            <div>
              <dt>Runtime</dt>
              <dd>Hyperframes {workspace.capabilities.hyperframesVersion}</dd>
            </div>
            <div>
              <dt>Composition</dt>
              <dd>1920 × 1080</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>{workspace.project.title}</dd>
            </div>
          </dl>
          <button className="button button--primary" type="button" onClick={onReturn}>
            Go to live project <ArrowRight aria-hidden="true" />
          </button>
        </aside>
      </div>
    </main>
  );
}

function DecisionDialog({
  action,
  receipt,
  reason,
  pending,
  onReasonChange,
  onCancel,
  onConfirm,
}: {
  action: ConfirmAction;
  receipt: RunReceiptV1;
  reason: string;
  pending: boolean;
  onReasonChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, pending]);

  const title =
    action === "apply"
      ? "Apply verified candidate?"
      : action === "reject"
        ? "Reject this candidate?"
        : "Cancel active job?";
  const detail =
    action === "apply"
      ? `Accepted source will advance from ${shortCommit(receipt.baseCommit)} to ${receipt.candidateCommit ? shortCommit(receipt.candidateCommit) : "the candidate commit"}.`
      : action === "reject"
        ? "The candidate remains recorded, but accepted source will not change."
        : "Codex and child verification processes will stop. Partial artifacts remain isolated.";

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="decision-title">
        <header>
          <h2 id="decision-title">{title}</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close dialog"
            disabled={pending}
            onClick={onCancel}
          >
            <X />
          </button>
        </header>
        <p>{detail}</p>
        {action === "reject" ? (
          <label className="dialog__field">
            <span>Reason (optional)</span>
            <textarea
              value={reason}
              maxLength={500}
              rows={3}
              onChange={(event) => onReasonChange(event.target.value)}
            />
          </label>
        ) : null}
        <footer>
          <button className="button" type="button" disabled={pending} onClick={onCancel}>
            Keep working
          </button>
          <button
            className={`button ${action === "apply" ? "button--primary" : "button--danger"}`}
            type="button"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending
              ? "Working…"
              : action === "apply"
                ? "Apply candidate"
                : action === "reject"
                  ? "Reject candidate"
                  : "Cancel job"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function StatePanel({
  tone,
  icon,
  title,
  live,
  children,
}: {
  tone: "neutral" | "amber" | "red" | "green";
  icon: ReactNode;
  title: string;
  live: "polite" | "assertive";
  children: ReactNode;
}) {
  return (
    <section className={`state-panel state-panel--${tone}`} aria-live={live}>
      <span className="state-panel__icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <h2>{title}</h2>
        {children}
      </div>
    </section>
  );
}

function InlineRequestError({ error }: { error: ApiRequestError }) {
  return (
    <div className="inline-error" role="alert">
      <XCircle aria-hidden="true" />
      <div>
        <strong>
          {error.code === "stale_base" ? "Accepted source changed" : "Request failed"}
        </strong>
        <p>{error.message}</p>
        {error.requestId ? <code>request {error.requestId}</code> : null}
      </div>
    </div>
  );
}

function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  useEffect(() => {
    const timeout = window.setTimeout(onDismiss, 6_000);
    return () => window.clearTimeout(timeout);
  }, [onDismiss]);

  return (
    <aside className="toast" role="status">
      <SealCheck aria-hidden="true" />
      <div>
        <strong>{toast.title}</strong>
        <p>{toast.detail}</p>
      </div>
      <button
        className="icon-button"
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <X />
      </button>
    </aside>
  );
}

function StartupState({ state, error }: { state: LoadState; error: Error | null }) {
  if (state === "loading") {
    return (
      <main className="startup" aria-live="polite">
        <span className="brand__mark" aria-hidden="true">
          S
        </span>
        <span className="eyebrow">Sequences</span>
        <h1>Opening the local proof desk</h1>
        <p>Connecting to the pinned Hyperframes and Codex foundation…</p>
        <span className="startup__activity" />
      </main>
    );
  }

  const missing = error instanceof MissingLocalSessionError;
  return (
    <main className="startup startup--error" aria-live="assertive">
      <WarningCircle aria-hidden="true" />
      <span className="eyebrow">{missing ? "Local session required" : "Startup failed"}</span>
      <h1>{missing ? "Use the server-issued localhost URL" : "Sequences could not open"}</h1>
      <p>{error?.message ?? "The local server did not return its startup contract."}</p>
      <code>{missing ? "bun run dev" : "bun run doctor"}</code>
      <button
        className="button button--primary"
        type="button"
        onClick={() => window.location.reload()}
      >
        Try again
      </button>
    </main>
  );
}

interface StageRow {
  key: "preparing" | "authoring" | "verifying" | "review";
  label: string;
  status: "pending" | "current" | "complete" | "failed";
  message: string;
  context: string | null;
  elapsedMs: number | null;
}

function buildStageRows(receipt: RunReceiptV1, events: JobEvent[]): StageRow[] {
  const definitions = [
    { key: "preparing", label: "Preparing" },
    { key: "authoring", label: "Authoring" },
    { key: "verifying", label: "Verifying" },
    { key: "review", label: "Review ready" },
  ] as const;
  const currentIndex = stateStageIndex(receipt.state, events);
  const terminalFailure = ["failed", "timed_out", "cancelled", "stale"].includes(receipt.state);

  return definitions.map((definition, index) => {
    const matching = events.filter((event) => eventStageKey(event) === definition.key).at(-1);
    let status: StageRow["status"];
    if (terminalFailure && index === currentIndex) status = "failed";
    else if (index < currentIndex) status = "complete";
    else if (index === currentIndex && !["applied", "rejected"].includes(receipt.state))
      status = "current";
    else if (index === currentIndex) status = "complete";
    else status = "pending";

    const fallback =
      status === "complete"
        ? `${definition.label} completed.`
        : status === "current"
          ? defaultStageMessage(definition.key, receipt)
          : "Waiting for the previous observed stage.";
    const context = matching?.currentFile ?? matching?.tool ?? null;
    return {
      key: definition.key,
      label: definition.label,
      status,
      message: matching?.message ?? fallback,
      context,
      elapsedMs: matching?.elapsedMs ?? null,
    };
  });
}

function stateStageIndex(state: JobState, events: JobEvent[]): number {
  if (state === "queued" || state === "preparing") return 0;
  if (state === "authoring") return 1;
  if (state === "verifying") return 2;
  if (["review_ready", "applying", "applied", "rejected", "stale"].includes(state)) return 3;
  const latest = events.at(-1);
  if (!latest) return 0;
  const key = eventStageKey(latest);
  return key === "preparing" ? 0 : key === "authoring" ? 1 : key === "verifying" ? 2 : 3;
}

function eventStageKey(event: JobEvent): StageRow["key"] {
  if (event.stage === "preparing" || event.stage === "queued") return "preparing";
  if (event.stage === "authoring") return "authoring";
  if (event.stage === "verifying") return "verifying";
  return "review";
}

function defaultStageMessage(key: StageRow["key"], receipt: RunReceiptV1): string {
  if (receipt.error) return receipt.error.message;
  if (key === "preparing")
    return "Creating an isolated candidate and resolving the pinned skill context.";
  if (key === "authoring") return "Codex is working inside the candidate workspace.";
  if (key === "verifying") return "Hyperframes lint and check are evaluating the candidate.";
  return "The candidate and its typed receipt are ready for a human decision.";
}

function useElapsed(receipt: RunReceiptV1): number {
  const finalMs = receipt.finishedAt
    ? Date.parse(receipt.finishedAt) - Date.parse(receipt.createdAt)
    : null;
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, finalMs ?? Date.now() - Date.parse(receipt.createdAt)),
  );

  useEffect(() => {
    if (finalMs !== null) {
      setElapsed(Math.max(0, finalMs));
      return;
    }
    const update = () => setElapsed(Math.max(0, Date.now() - Date.parse(receipt.createdAt)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [finalMs, receipt.createdAt]);

  return elapsed;
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

function mergeJobEvent(events: JobEvent[], next: JobEvent): JobEvent[] {
  const bySequence = new Map(events.map((event) => [event.sequence, event]));
  bySequence.set(next.sequence, next);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence).slice(-200);
}

function routeFromLocation(): Route {
  const { pathname } = window.location;
  if (pathname === "/sample") return { mode: "sample" };
  const review = pathname.match(/^\/projects\/release-a\/review\/(run_[0-9a-f]{32})$/);
  if (review?.[1]) return { mode: "review", jobId: review[1] };
  if (pathname === "/projects/release-a/editor") return { mode: "editor" };
  return { mode: "create" };
}

function pathForRoute(route: Route): string {
  if (route.mode === "sample") return "/sample";
  if (route.mode === "editor") return `/projects/${PROJECT_ID}/editor`;
  if (route.mode === "review") return `/projects/${PROJECT_ID}/review/${route.jobId}`;
  return `/projects/${PROJECT_ID}/create`;
}

function workflowStep(receipt: RunReceiptV1 | null): number {
  if (!receipt) return 0;
  if (receipt.kind === "plan") return receipt.state === "review_ready" ? 1 : 0;
  if (receipt.state === "queued" || receipt.state === "preparing" || receipt.state === "authoring")
    return 1;
  if (receipt.state === "verifying") return 2;
  return 3;
}

function statusTone(state: JobState | undefined): "neutral" | "attention" | "danger" | "pass" {
  if (
    !state ||
    ["queued", "preparing", "authoring", "applying", "cancelled", "rejected"].includes(state)
  )
    return "neutral";
  if (["verifying", "review_ready", "timed_out", "stale"].includes(state)) return "attention";
  if (state === "failed") return "danger";
  return "pass";
}

function toApiError(error: unknown): ApiRequestError {
  return error instanceof ApiRequestError
    ? error
    : new ApiRequestError(error instanceof Error ? error.message : "The local request failed.");
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
