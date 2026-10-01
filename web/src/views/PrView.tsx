import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DiffSelection,
  DraftUpdate,
  Finding,
  PullRequest,
  PullRequestDetail,
  QuestionMode,
  ReviewDraft,
  Submission,
} from "../../../shared/contracts";
import { api, RequestError } from "../api/client";
import { useApp } from "../app-context";
import { AskPanel, type AddTarget, type PanelView } from "../components/AskPanel";
import { DiffView } from "../components/DiffView";
import { QuestionsCard } from "../components/Questions";
import { parseDiff, resolveSelection } from "../lib/diff";
import { resolveRowRange, type RowRange } from "../lib/selection";
import { DraftEditor } from "../components/DraftEditor";
import { ProposalCard, RevisionForm } from "../components/Proposals";
import { RunHistory } from "../components/RunHistory";
import { SubmissionResult, SubmitModal } from "../components/SubmitModal";
import { Description } from "../components/Description";
import { AutomationOverridesCard } from "../components/Automation";
import { applicable, FreshnessNotice, reviewBaseline } from "../components/Freshness";
import { MergeRow } from "../components/Merge";
import { triggerLabel } from "../components/RunHistory";
import { RunStage, useNow } from "../components/Progress";
import { Notice, Pill, Spinner, StatusDot, StatusPill, useToast } from "../components/ui";
import {
  compatibleDraft,
  draftLabel,
  isManual,
  latestDraft,
  sameDraft,
  toUpdate,
} from "../lib/draft";
import { relativeTime, shortSha } from "../lib/format";
import { setNavigationGuard } from "../lib/router";

const UNSAVED = "You have unsaved draft edits. Leave and discard them?";
const SWITCH = "You have unsaved draft edits. Switch drafts and discard them?";

const isDirty = (edit: DraftUpdate | null, saved: ReviewDraft | null) =>
  !!(edit && saved && edit.draftId === saved.id && !sameDraft(edit, toUpdate(saved)));

interface PanelState {
  range: RowRange;
  resolved: DiffSelection;
  threadId: string | null;
  view: PanelView;
  key: number;
}

export function PrView({ id, listed }: { id: string; listed: PullRequest | undefined }) {
  const { state, detailVersion, refresh, navigate } = useApp();
  const toast = useToast();
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edit, setEdit] = useState<DraftUpdate | null>(null);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [selectionNote, setSelectionNote] = useState<string | null>(null);
  const checkRef = useRef(false);
  const editRef = useRef(edit);
  editRef.current = edit;
  const savedRef = useRef<ReviewDraft | null>(null);
  const selectedRef = useRef<string | null>(null);

  const drafts = detail?.drafts ?? [];
  const latest = latestDraft(drafts);
  const saved = drafts.find((d) => d.id === selectedId) ?? null;
  const dirty = isDirty(edit, saved);

  const adopt = useCallback((next: PullRequestDetail) => {
    const current = editRef.current;
    const previous = savedRef.current;
    setDetail(next);
    setError(null);
    const chosen =
      selectedRef.current && next.drafts.some((d) => d.id === selectedRef.current)
        ? selectedRef.current
        : (latestDraft(next.drafts)?.id ?? null);
    selectedRef.current = chosen;
    setSelectedId(chosen);
    const draft = next.drafts.find((d) => d.id === chosen) ?? null;
    savedRef.current = draft;
    if (!draft) {
      setEdit(null);
      return;
    }
    const base = toUpdate(draft);
    if (!isDirty(current, previous)) {
      setEdit(base);
      setRemoteChanged(false);
    } else if (draft.version !== current!.version) {
      setRemoteChanged(true);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      adopt(await api.detail(id));
    } catch (e) {
      setError(e instanceof RequestError ? e.message : String(e));
    }
  }, [id, adopt]);

  useEffect(() => {
    setDetail(null);
    setEdit(null);
    savedRef.current = null;
    selectedRef.current = null;
    setSelectedId(null);
    setRemoteChanged(false);
    setConflict(null);
    setCheckError(null);
    void load();
  }, [load]);

  const check = useCallback(async () => {
    if (checkRef.current) return;
    checkRef.current = true;
    setChecking(true);
    try {
      adopt(await api.check(id));
      setCheckError(null);
    } catch (e) {
      setCheckError(e instanceof RequestError ? e.message : String(e));
    } finally {
      checkRef.current = false;
      setChecking(false);
    }
  }, [id, adopt]);

  const loaded = detail !== null;
  const baseline = detail ? reviewBaseline(latest) : null;
  const headSha = detail?.pr.headSha ?? null;
  useEffect(() => {
    if (loaded) void check();
  }, [loaded, baseline, headSha, check]);

  const version = (detailVersion[id] ?? 0) + (detailVersion["*"] ?? 0);
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current !== version) {
      seen.current = version;
      void load();
    }
  }, [version, load]);

  useEffect(() => {
    if (!dirty) {
      setNavigationGuard(null);
      return;
    }
    setNavigationGuard(() => window.confirm(UNSAVED));
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      setNavigationGuard(null);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);

  const run = async (label: string, action: () => Promise<PullRequestDetail>, success?: string) => {
    setBusy(label);
    try {
      adopt(await action());
      if (success) toast(success);
      return true;
    } catch (e) {
      const message = e instanceof RequestError ? e.message : String(e);
      toast(message, "danger");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = useCallback(async () => {
    if (!edit) return;
    setBusy("save");
    setConflict(null);
    try {
      adopt(await api.saveDraft(id, edit));
      toast("Draft saved");
    } catch (e) {
      const err = e instanceof RequestError ? e : null;
      if (err?.conflict) {
        setConflict(err.message);
        void load();
      } else toast(err?.message ?? String(e), "danger");
    } finally {
      setBusy(null);
    }
  }, [edit, id, adopt, load, toast]);

  const discard = () => {
    if (saved) setEdit(toUpdate(saved));
    setRemoteChanged(false);
    setConflict(null);
  };

  const showDraft = (target: ReviewDraft, findings?: Finding[]) => {
    selectedRef.current = target.id;
    savedRef.current = target;
    setSelectedId(target.id);
    const base = toUpdate(target);
    setEdit(findings ? { ...base, findings: [...base.findings, ...findings] } : base);
    setRemoteChanged(false);
    setConflict(null);
  };

  const openDraft = (draftId: string) => {
    if (draftId === selectedId || !detail) return;
    if (dirty && !window.confirm(SWITCH)) return;
    const target = detail.drafts.find((d) => d.id === draftId);
    if (target) showDraft(target);
  };

  const files = useMemo(() => parseDiff(detail?.diff ?? ""), [detail?.diff]);
  const paths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const headNow = detail?.pr.headSha ?? null;
  useEffect(() => {
    if (panel && headNow && panel.resolved.headSha !== headNow) {
      setPanel(null);
      setSelectionNote(
        `The pull request moved to ${shortSha(headNow)}, so the selection made on ${shortSha(panel.resolved.headSha)} was cleared. Earlier answers stay in the Questions card.`,
      );
    }
  }, [panel, headNow]);

  const selectRows = (range: RowRange | null, threadId: string | null = null) => {
    setSelectionNote(null);
    if (!range || !detail) {
      setPanel(null);
      return;
    }
    const resolved = resolveRowRange(files, range, detail.pr);
    if (!resolved) return;
    setPanel((current) => ({
      range,
      resolved,
      threadId,
      view: threadId ? "thread" : "toolbar",
      key: (current?.key ?? 0) + 1,
    }));
  };

  const pr = detail?.pr ?? listed;

  const addTarget = (): AddTarget => {
    if (!panel || !pr) return { kind: "stale", message: "Select code in the diff first." };
    const head = panel.resolved.headSha;
    if (head !== pr.headSha)
      return {
        kind: "stale",
        message: `This selection is about ${shortSha(head)}, but the pull request is now at ${shortSha(pr.headSha)}. Reselect on the current diff.`,
      };
    const label = (d: ReviewDraft) => draftLabel(d, drafts, pr.headSha, detail?.runs ?? []);
    if (saved && saved.headSha === head) return { kind: "open", label: label(saved) };
    const blocked = dirty
      ? `The open draft targets ${saved ? shortSha(saved.headSha) : "another commit"}. Save or discard your unsaved edits on it before switching.`
      : null;
    const compatible = compatibleDraft(drafts, head);
    return compatible
      ? { kind: "switch", label: label(compatible), blocked }
      : { kind: "create", blocked };
  };

  const focusFinding = (findingId: string) =>
    setTimeout(() => {
      const el = document.getElementById(`finding-${findingId}-body`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus({ preventScroll: true });
    }, 0);

  const addFinding = async (finding: Finding): Promise<string | null> => {
    const target = addTarget();
    if (target.kind === "stale") return target.message;
    if (target.kind !== "open" && target.blocked) return target.blocked;
    if (target.kind === "open") {
      if (!edit) return "No draft is open.";
      setEdit({ ...edit, findings: [...edit.findings, finding] });
    } else if (target.kind === "switch") {
      const compatible = compatibleDraft(drafts, panel!.resolved.headSha);
      if (!compatible) return "The compatible draft is no longer available.";
      showDraft(compatible, [finding]);
    } else {
      setBusy("draft");
      try {
        const next = await api.createDraft(id);
        const created = next.drafts.find((d) => isManual(d) && d.headSha === next.pr.headSha);
        if (!created || created.headSha !== panel!.resolved.headSha)
          return "The local draft could not be created for this commit.";
        selectedRef.current = created.id;
        adopt(next);
        showDraft(created, [finding]);
      } catch (e) {
        return e instanceof RequestError ? e.message : String(e);
      } finally {
        setBusy(null);
      }
    }
    setPanel(null);
    toast("Comment added to the draft. Save the draft when you are ready.");
    focusFinding(finding.id);
    return null;
  };

  const ask = async (mode: QuestionMode, question: string, parentId: string | null) => {
    if (!panel) return null;
    const { path, from, to, baseSha, headSha } = panel.resolved;
    const next = await api.ask(id, {
      mode,
      range: { path, from, to, baseSha, headSha },
      question,
      parentId,
      draftId: saved && saved.headSha === headSha ? saved.id : null,
    });
    adopt(next);
    return next.questions[next.questions.length - 1]?.id ?? null;
  };

  const questionAction = async (action: () => Promise<PullRequestDetail>) => {
    try {
      adopt(await action());
    } catch (e) {
      toast(e instanceof RequestError ? e.message : String(e), "danger");
    }
  };

  const showQuestion = (questionId: string) => {
    if (!detail) return;
    const question = detail.questions.find((q) => q.id === questionId);
    if (!question) return;
    const resolved = resolveSelection(files, question.selection);
    if (!resolved || question.headSha !== detail.pr.headSha) {
      setSelectionNote(
        `That question was asked on ${shortSha(question.headSha)}, which is not the diff shown here.`,
      );
      return;
    }
    selectRows({ path: resolved.file.path, from: resolved.from, to: resolved.to }, questionId);
    setTimeout(
      () =>
        document
          .querySelector(`tr[data-row="${resolved.to}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      0,
    );
  };

  const startLocalDraft = async () => {
    setBusy("draft");
    try {
      const next = await api.createDraft(id);
      const created = next.drafts.find((d) => isManual(d) && d.headSha === next.pr.headSha);
      if (created) selectedRef.current = created.id;
      adopt(next);
      toast("Local draft created. Add comments from the diff or the findings list.");
    } catch (e) {
      toast(e instanceof RequestError ? e.message : String(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const activeRun = detail?.runs.find((r) => r.status === "queued" || r.status === "running");
  const now = useNow(!!activeRun);

  if (!pr && !detail) {
    return error ? (
      <Notice
        tone="danger"
        title="Could not load this pull request."
        actions={
          <button type="button" className="button small" onClick={() => void load()}>
            Retry
          </button>
        }
      >
        {error}
      </Notice>
    ) : (
      <div className="center">
        <Spinner label="Loading pull request" />
      </div>
    );
  }
  if (!pr) return null;

  const pending =
    detail?.proposals.filter((p) => p.status === "pending" && p.draftId === selectedId) ?? [];
  const revisionRunning = activeRun?.kind === "revision";
  const reviewed = detail?.runs.some((r) => r.kind === "review" && r.status === "completed");
  const latestSubmission = detail?.submissions
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const draftOutdated = !!saved && saved.headSha !== pr.headSha;
  const draftSubmitted = pr.status === "submitted" && saved?.id === latest?.id;
  const canSubmit =
    !!saved &&
    !dirty &&
    !draftOutdated &&
    !draftSubmitted &&
    pr.state === "OPEN" &&
    latestSubmission?.status !== "submitting" &&
    latestSubmission?.status !== "uncertain";

  const onSubmitted = (submission: Submission) => {
    void load();
    void refresh();
    toast(
      submission.status === "submitted"
        ? "Review submitted to GitHub"
        : submission.status === "uncertain"
          ? "Submission outcome is uncertain"
          : "Submission failed",
      submission.status === "submitted" ? "ok" : "danger",
    );
  };

  const reviewAction = async () => {
    await run("review", () => api.review(id), "Synced to the latest commit and queued a review");
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div className="pr-title">
          <div className="row wrap">
            <StatusPill status={pr.status} />
            {pr.state !== "OPEN" && <Pill tone="neutral">{pr.state.toLowerCase()}</Pill>}
            {pr.requested && (
              <Pill tone="info">Review requested {relativeTime(pr.requestedAt)}</Pill>
            )}
          </div>
          <h1>
            <span className="num">#{pr.number}</span>
            {pr.title}
          </h1>
          <div className="pr-facts">
            <span>{pr.author}</span>
            <span>
              <span className="mono">{pr.headRef}</span> →{" "}
              <span className="mono">{pr.baseRef}</span>
            </span>
            <span className="mono" title={pr.headSha}>
              {shortSha(pr.headSha)}
            </span>
            <span className="diffstat">
              <span className="add">+{pr.additions}</span>{" "}
              <span className="del">-{pr.deletions}</span> · {pr.changedFiles} files
            </span>
            <span>updated {relativeTime(pr.updatedAt)}</span>
            <a href={pr.url} target="_blank" rel="noreferrer">
              Open on GitHub ↗
            </a>
          </div>
        </div>
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={busy !== null || !!activeRun}
            onClick={() => void reviewAction()}
          >
            {activeRun && !revisionRunning
              ? "Review in progress"
              : busy === "review"
                ? "Syncing latest commit"
                : reviewed
                  ? "Re-review"
                  : "Review now"}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!canSubmit || busy !== null}
            title={
              !saved
                ? "No draft yet"
                : dirty
                  ? "Save your edits first"
                  : draftOutdated
                    ? "This draft targets an older commit"
                    : draftSubmitted
                      ? "This draft has already been submitted"
                      : undefined
            }
            onClick={() => setSubmitting(true)}
          >
            Preview and submit
          </button>
        </div>
      </div>

      {error && (
        <Notice
          tone="warn"
          title="Refresh failed."
          actions={
            <button type="button" className="button small" onClick={() => void load()}>
              Retry
            </button>
          }
        >
          {error}
        </Notice>
      )}
      {latestSubmission?.status === "uncertain" && (
        <Notice tone="warn" title="Last submission is unresolved.">
          The backend recorded an in-flight write whose result is unknown. Check GitHub before
          submitting again.
        </Notice>
      )}
      {latestSubmission?.status === "submitting" && (
        <Notice tone="info" title="Submission in flight.">
          Waiting for GitHub to confirm the review.
        </Notice>
      )}
      {detail && (
        <FreshnessNotice
          pr={pr}
          draft={latest}
          freshness={detail.freshness}
          checking={checking}
          checkError={checkError}
          onCheck={() => void check()}
        />
      )}
      {pr.status === "failed" && !activeRun && (
        <Notice tone="danger" title="The last review failed.">
          {detail?.runs.find((r) => r.status === "failed")?.error ?? "See the run log for details."}
        </Notice>
      )}
      {busy === "review" && !activeRun && (
        <Notice tone="info">
          <span className="row">
            <span className="spinner" aria-hidden="true" />
            Syncing latest PR from GitHub before queuing the review. Nothing is queued unless the
            refresh succeeds.
          </span>
        </Notice>
      )}
      {activeRun && (
        <Notice tone="info">
          <div className="stack review-live">
            <span className="row">
              <span className="spinner" aria-hidden="true" />
              {activeRun.trigger === "new_commits"
                ? "Automatic review of new commits"
                : activeRun.trigger === "request"
                  ? "Requested review"
                  : triggerLabel[activeRun.trigger]}{" "}
              is {activeRun.status === "queued" ? "queued" : "running"}.{" "}
              {activeRun.kind === "review"
                ? "It will add a new draft here without replacing the one you are editing."
                : "Results arrive here without reloading."}
            </span>
            <RunStage run={activeRun} now={now} />
          </div>
        </Notice>
      )}

      <div className="pr-layout">
        <div className="pr-main">
          {!detail && <Spinner label="Loading review" />}
          {detail &&
            pending.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                draft={saved}
                busy={busy !== null}
                dirty={dirty}
                onApply={() =>
                  saved &&
                  void run(
                    "apply",
                    () => api.applyProposal(id, p.id, saved.version),
                    "Proposal accepted into draft",
                  )
                }
                onReject={() =>
                  void run("reject", () => api.rejectProposal(id, p.id), "Proposal rejected")
                }
                onRegenerate={() =>
                  saved &&
                  void run(
                    "revise",
                    async () => {
                      await api.rejectProposal(id, p.id);
                      return api.revise(id, {
                        draftId: saved.id,
                        draftVersion: saved.version,
                        instructions: p.instructions,
                      });
                    },
                    "Revision requested against the current draft",
                  )
                }
              />
            ))}
          {detail && saved && edit && (
            <DraftEditor
              saved={saved}
              drafts={drafts}
              runs={detail.runs}
              headSha={pr.headSha}
              edit={edit}
              dirty={dirty}
              remoteChanged={remoteChanged}
              conflict={conflict}
              saving={busy === "save"}
              onEdit={setEdit}
              onSave={() => void save()}
              onDiscard={discard}
              onSelect={openDraft}
            />
          )}
          {detail && !saved && (
            <section className="card empty">
              <h2>No draft yet</h2>
              <p>
                {activeRun
                  ? "The first completed review will create the draft automatically."
                  : pr.status === "failed"
                    ? "The review failed before producing a result. Fix the cause and run it again."
                    : "Run a review to get a draft you can edit. Every completed review adds its own draft."}
              </p>
              <p>
                You can also comment without an AI review: select code in the diff and choose Add
                comment, or start an empty local draft now.
              </p>
              <div>
                <button
                  type="button"
                  className="button small"
                  disabled={busy !== null}
                  onClick={() => void startLocalDraft()}
                >
                  Start a local draft
                </button>
              </div>
            </section>
          )}
          {detail && saved && !isManual(saved) && (
            <section className="card" aria-labelledby="revise-h">
              <div className="card-head">
                <h2 id="revise-h">AI revision</h2>
                {revisionRunning && (
                  <Pill tone="accent" live>
                    Working
                  </Pill>
                )}
              </div>
              <div className="card-body">
                <RevisionForm
                  draft={saved}
                  dirty={dirty}
                  busy={busy !== null || revisionRunning}
                  onRevise={async (instructions, findingIds) => {
                    await run(
                      "revise",
                      () =>
                        api.revise(id, {
                          draftId: saved.id,
                          draftVersion: saved.version,
                          instructions,
                          ...(findingIds.length ? { findingIds } : {}),
                        }),
                      "Revision requested; a proposal will appear here",
                    );
                  }}
                />
              </div>
            </section>
          )}
          {detail && (
            <section className="card" aria-labelledby="diff-h">
              <div className="card-head">
                <h2 id="diff-h">Diff</h2>
                <span className="small faint mono">
                  {shortSha(pr.baseSha)}..{shortSha(pr.headSha)}
                </span>
              </div>
              {selectionNote && (
                <div style={{ padding: "0 12px 12px" }}>
                  <Notice tone="info">
                    <span className="small">{selectionNote}</span>
                  </Notice>
                </div>
              )}
              <p className="diff-hint small faint">
                Select code with the mouse or click line numbers (Shift-click or drag for a range)
                to ask AI about it or add a comment.
              </p>
              <DiffView
                diff={detail.diff}
                truncated={detail.diffTruncated}
                findings={edit?.findings ?? []}
                selection={panel?.range ?? null}
                onSelect={(range) => selectRows(range)}
                onReject={setSelectionNote}
                panel={
                  panel && (
                    <AskPanel
                      key={panel.key}
                      selection={panel.resolved}
                      stale={panel.resolved.headSha !== pr.headSha}
                      paths={paths}
                      questions={detail.questions}
                      initialThreadId={panel.threadId}
                      initialView={panel.view}
                      target={addTarget()}
                      draftId={saved?.id ?? null}
                      busy={busy !== null}
                      onAsk={ask}
                      onCancel={(qid) => questionAction(() => api.cancelQuestion(id, qid))}
                      onRetry={(qid) => questionAction(() => api.retryQuestion(id, qid))}
                      onAdd={addFinding}
                      onClose={() => selectRows(null)}
                    />
                  )
                }
              />
            </section>
          )}
        </div>

        <aside className="pr-side">
          <section className="card" aria-labelledby="status-h">
            <div className="card-head">
              <h2 id="status-h">Status</h2>
            </div>
            <div className="card-body">
              <dl className="kv status">
                <dt>State</dt>
                <dd>
                  <StatusDot status={pr.status} />
                </dd>
                <dt>Merge</dt>
                <dd>
                  <MergeRow pr={pr} checking={checking} />
                </dd>
                <dt>Last reviewed</dt>
                <dd>{relativeTime(pr.lastReviewedAt)}</dd>
                <dt>Draft</dt>
                <dd>
                  {saved ? draftLabel(saved, drafts, pr.headSha, detail?.runs ?? []) : "none"}
                </dd>
                <dt>Proposals</dt>
                <dd>{pending.length ? `${pending.length} pending` : "none pending"}</dd>
                {baseline && (
                  <>
                    <dt>Head check</dt>
                    <dd>
                      {checking && !applicable(detail?.freshness ?? null, baseline, pr.headSha)
                        ? "checking GitHub"
                        : detail?.freshness && applicable(detail.freshness, baseline, pr.headSha)
                          ? `${detail.freshness.status === "fresh" ? "up to date" : detail.freshness.status}${detail.freshness.error ? ", last check failed" : ""} · ${relativeTime(detail.freshness.checkedAt)}`
                          : "not checked yet"}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </section>
          <section className="card" aria-labelledby="automation-h">
            <div className="card-head">
              <h2 id="automation-h">Automation</h2>
              {Object.values(pr.automation).some((mode) => mode !== "inherit") ? (
                <Pill tone="accent">Overridden</Pill>
              ) : (
                <Pill plain>Inherits</Pill>
              )}
            </div>
            <div className="card-body">
              <AutomationOverridesCard
                global={state.settings.automation}
                overrides={pr.automation}
                busy={busy !== null}
                onChange={(overrides) =>
                  void run(
                    "automation",
                    () => api.updateAutomation(id, overrides),
                    "Automation updated for this pull request",
                  )
                }
              />
            </div>
          </section>
          {pr.body && <Description body={pr.body} />}
          {detail && detail.questions.length > 0 && (
            <QuestionsCard
              questions={detail.questions}
              headSha={pr.headSha}
              paths={paths}
              onShow={showQuestion}
            />
          )}
          <section className="card" aria-labelledby="runs-h">
            <div className="card-head">
              <h2 id="runs-h">Runs</h2>
              <span className="small faint">{detail?.runs.length ?? 0}</span>
            </div>
            <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
              {detail ? (
                <RunHistory
                  runs={detail.runs}
                  drafts={drafts}
                  selectedId={selectedId}
                  headSha={pr.headSha}
                  busy={busy !== null}
                  onOpen={openDraft}
                />
              ) : (
                <div className="skeleton" />
              )}
            </div>
          </section>
          <section className="card" aria-labelledby="subs-h">
            <div className="card-head">
              <h2 id="subs-h">Submissions</h2>
              <span className="small faint">{detail?.submissions.length ?? 0}</span>
            </div>
            <div className="card-body">
              {detail && detail.submissions.length === 0 && (
                <p className="muted small">Nothing has been sent to GitHub.</p>
              )}
              <div className="subs">
                {detail?.submissions
                  .slice()
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((s) => (
                    <SubmissionResult key={s.id} submission={s} />
                  ))}
              </div>
            </div>
          </section>
        </aside>
      </div>

      {submitting && saved && (
        <SubmitModal
          prId={id}
          draftId={saved.id}
          draftVersion={saved.version}
          findings={saved.findings}
          onClose={() => setSubmitting(false)}
          onSubmitted={onSubmitted}
          onBackToInbox={() => {
            setSubmitting(false);
            navigate({ name: "inbox" });
          }}
        />
      )}
    </div>
  );
}
