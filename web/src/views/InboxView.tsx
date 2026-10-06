import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AppState, ImportOperation, PrStatus, PullRequest } from "../../../shared/contracts";
import { api, RequestError } from "../api/client";
import { useApp } from "../app-context";
import { ReviewControls } from "../components/ReviewControls";
import { BacklogReview } from "../components/BacklogReview";
import { AutoSubmissionBadges } from "../components/AutoSubmission";
import { Notice, StatusPill, ViewerApprovalPill, useToast } from "../components/ui";
import { relativeTime, statusLabel } from "../lib/format";
import {
  ageOf,
  compareInbox,
  defaultDisclosure,
  groupOf,
  inboxGroups,
  type Disclosure,
  type InboxGroup,
} from "../lib/inbox";
import { mergeSummary, mergeView } from "../lib/merge";
import { hrefFor } from "../lib/router";

type Filter = "all" | "attention" | PrStatus;

const attention = new Set<PrStatus>(["ready", "outdated", "failed"]);
const filterOrder: Filter[] = [
  "all",
  "attention",
  "unreviewed",
  "queued",
  "reviewing",
  "ready",
  "outdated",
  "submitted",
  "failed",
];

function matches(pr: PullRequest, filter: Filter) {
  if (filter === "all") return true;
  if (filter === "attention") return attention.has(pr.status);
  return pr.status === filter;
}

function pollingSummary(state: AppState): string {
  const { automation, pollIntervalSeconds } = state.settings;
  if (automation.pollCommits || automation.pollRequests)
    return `Polling every ${pollIntervalSeconds}s, last ${relativeTime(state.health.lastPollAt)}.`;
  return "Background polling is off. Sync manually or turn it on in Settings.";
}

function readFilter(): Filter {
  try {
    const stored = sessionStorage.getItem("inbox.filter");
    return stored && (filterOrder as string[]).includes(stored) ? (stored as Filter) : "all";
  } catch {
    return "all";
  }
}

function importKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const number = Number(parts[3]);
    return parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parts.length === 4 &&
      parts[2] === "pull" &&
      Number.isInteger(number) &&
      number > 0
      ? `${parts[0]}/${parts[1]}#${number}`
      : null;
  } catch {
    return null;
  }
}

const operationKey = (op: ImportOperation) => `${op.repository}#${op.number}`;

function readDismissed(): string[] {
  try {
    const stored = JSON.parse(sessionStorage.getItem("inbox.dismissedOperations") ?? "[]");
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function readDisclosure(): Disclosure {
  try {
    const stored = JSON.parse(sessionStorage.getItem("inbox.groups") ?? "{}") as Partial<
      Record<string, unknown>
    >;
    const next = { ...defaultDisclosure };
    for (const group of inboxGroups)
      if (typeof stored[group.key] === "boolean") next[group.key] = stored[group.key] as boolean;
    return next;
  } catch {
    return { ...defaultDisclosure };
  }
}

function reviewAction(pr: PullRequest, syncing: boolean) {
  if (syncing) return { label: "Syncing", enabled: false, busy: true };
  if (pr.status === "queued" || pr.status === "reviewing")
    return { label: statusLabel[pr.status], enabled: false, busy: false };
  if (pr.hasReviewedHead) return null;
  return { label: pr.lastReviewedAt ? "Re-review" : "Review", enabled: true, busy: false };
}

function ageLabel(pr: PullRequest): string {
  const age = ageOf(pr);
  return age.at ? `${age.kind} ${relativeTime(age.at)}` : "opened at an unknown time";
}

export function InboxView() {
  const { state, setState, navigate, refresh } = useApp();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(readFilter);
  const [disclosure, setDisclosure] = useState<Disclosure>(readDisclosure);
  const [importUrl, setImportUrl] = useState("");
  const [syncRequested, setSyncRequested] = useState(false);
  const [importing, setImporting] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [notice, setNotice] = useState<{ tone: "danger" | "warn"; text: string } | null>(null);
  const [syncing, setSyncing] = useState<Record<string, true>>({});
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem("inbox.filter", filter);
    } catch {
      /* storage unavailable */
    }
  }, [filter]);

  useEffect(() => {
    try {
      sessionStorage.setItem("inbox.dismissedOperations", JSON.stringify(dismissed));
    } catch {
      /* storage unavailable */
    }
  }, [dismissed]);

  useEffect(() => {
    try {
      sessionStorage.setItem("inbox.groups", JSON.stringify(disclosure));
    } catch {
      /* storage unavailable */
    }
  }, [disclosure]);

  const counts = useMemo(() => {
    const c = {} as Record<Filter, number>;
    for (const f of filterOrder) c[f] = state.prs.filter((p) => matches(p, f)).length;
    return c;
  }, [state.prs]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups = {} as Record<InboxGroup, { total: number; visible: PullRequest[] }>;
    for (const group of inboxGroups) groups[group.key] = { total: 0, visible: [] };
    for (const pr of state.prs) {
      const group = groups[groupOf(pr)];
      group.total += 1;
      if (
        matches(pr, filter) &&
        (!q || `#${pr.number} ${pr.title} ${pr.author} ${pr.headRef}`.toLowerCase().includes(q))
      )
        group.visible.push(pr);
    }
    for (const group of inboxGroups) groups[group.key].visible.sort(compareInbox);
    return groups;
  }, [state.prs, filter, query]);
  const visibleTotal = inboxGroups.reduce((n, g) => n + grouped[g.key].visible.length, 0);
  const narrowed = filter !== "all" || query.trim() !== "";

  const repository = state.settings.repository;
  const syncOp = state.operations.sync;
  const syncActive = syncRequested || syncOp?.status === "running";
  const syncOutcome = syncOp?.repository === repository ? syncOp : null;
  const running = (key: string) =>
    importing.includes(key) ||
    state.operations.imports.some((op) => operationKey(op) === key && op.status === "running");
  const inputKey = importKey(importUrl.trim());
  const inputActive = inputKey !== null && running(inputKey);
  const imports = state.operations.imports
    .filter(
      (op) =>
        op.repository === repository &&
        !dismissed.includes(op.id) &&
        (op.status === "running" || !importing.includes(operationKey(op))),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const lost = (action: string) =>
    setNotice({
      tone: "warn",
      text: `Lost contact with the backend while ${action}. Showing its current state instead of retrying.`,
    });

  const sync = async () => {
    setSyncRequested(true);
    setNotice(null);
    try {
      const next = await api.sync();
      if (next.operations.sync?.status === "completed") toast("Synced with GitHub");
    } catch (e) {
      if (e instanceof RequestError) setNotice({ tone: "danger", text: e.message });
      else lost("syncing");
    } finally {
      await refresh();
      setSyncRequested(false);
    }
  };

  const review = async (pr: PullRequest) => {
    if (syncing[pr.id]) return;
    setSyncing((s) => ({ ...s, [pr.id]: true }));
    try {
      await api.review(pr.id);
      toast(`#${pr.number}: synced to the latest commit and queued a review`);
    } catch (e) {
      toast(`#${pr.number}: ${e instanceof RequestError ? e.message : String(e)}`, "danger");
    }
    await refresh();
    setSyncing(({ [pr.id]: _done, ...rest }) => rest);
  };

  const startImport = async (url: string) => {
    const key = importKey(url);
    if (key) setImporting((keys) => [...keys, key]);
    setNotice(null);
    try {
      const detail = await api.importPr(url);
      setImportUrl((current) => (current.trim() === url ? "" : current));
      if (mounted.current) navigate({ name: "pr", id: detail.pr.id });
    } catch (err) {
      const fresh = await api.state().catch(() => null);
      if (fresh) setState(fresh);
      if (!(err instanceof RequestError)) lost(`importing ${url}`);
      else if (
        !fresh?.operations.imports.some(
          (op) => operationKey(op) === key && op.status === "failed" && op.error === err.message,
        )
      )
        setNotice({ tone: "danger", text: err.message });
    } finally {
      if (key) setImporting((keys) => keys.filter((k) => k !== key));
    }
  };

  const doImport = (e: FormEvent) => {
    e.preventDefault();
    void startImport(importUrl.trim());
  };

  const dismiss = (op: ImportOperation) =>
    setDismissed((ids) => [
      ...ids.filter((id) => state.operations.imports.some((o) => o.id === id)),
      op.id,
    ]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p className="muted small">{pollingSummary(state)}</p>
        </div>
        <div className="actions">
          <BacklogReview refresh={refresh} />
          <form className="import-form" onSubmit={doImport}>
            <label className="sr-only" htmlFor="import-url">
              Pull request URL
            </label>
            <input
              id="import-url"
              className="input"
              type="url"
              placeholder="Import PR by URL"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              required
            />
            <button
              type="submit"
              className="button"
              disabled={inputActive || !importUrl.trim()}
              aria-busy={inputActive || undefined}
            >
              {inputActive && <span className="spinner" aria-hidden="true" />}
              {inputActive ? "Importing..." : "Import"}
            </button>
          </form>
          <button
            type="button"
            className="button"
            onClick={() => void sync()}
            disabled={syncActive}
            aria-busy={syncActive || undefined}
          >
            {syncActive && <span className="spinner" aria-hidden="true" />}
            {syncActive ? "Syncing..." : "Sync now"}
          </button>
        </div>
      </div>
      <div className="refresh-activity" role="status" aria-label="Sync and import activity">
        {syncOp?.status === "running" && (
          <p className="refresh-row">
            <span className="spinner" aria-hidden="true" />
            {syncOp.repository === repository
              ? `${syncOp.mode === "scheduled" ? "Scheduled sync" : "Syncing"} with GitHub, started ${relativeTime(syncOp.startedAt)}.`
              : `Finishing a sync of ${syncOp.repository} started ${relativeTime(syncOp.startedAt)}.`}
          </p>
        )}
        {syncOutcome?.status === "completed" && (
          <p className="refresh-row muted">
            Last sync completed {relativeTime(syncOutcome.finishedAt)}.
          </p>
        )}
        {imports
          .filter((op) => op.status !== "failed")
          .map((op) =>
            op.status === "running" ? (
              <p key={op.id} className="refresh-row">
                <span className="spinner" aria-hidden="true" />
                Importing #{op.number}, started {relativeTime(op.startedAt)}.
              </p>
            ) : (
              <p key={op.id} className="refresh-row muted">
                <span>
                  <a href={hrefFor({ name: "pr", id: op.prId })}>Imported #{op.number}</a>{" "}
                  {relativeTime(op.finishedAt)}.
                </span>
                <button
                  type="button"
                  className="button small ghost"
                  aria-label={`Dismiss import of #${op.number}`}
                  onClick={() => dismiss(op)}
                >
                  Dismiss
                </button>
              </p>
            ),
          )}
      </div>
      {notice && (
        <div style={{ marginBottom: 14 }}>
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}
      {imports
        .filter((op) => op.status === "failed")
        .map((op) => (
          <div key={op.id} style={{ marginBottom: 14 }}>
            <Notice
              tone="danger"
              title={`Import of #${op.number} failed ${relativeTime(op.finishedAt)}.`}
              actions={
                <>
                  <button
                    type="button"
                    className="button small"
                    disabled={running(operationKey(op))}
                    onClick={() =>
                      void startImport(`https://github.com/${op.repository}/pull/${op.number}`)
                    }
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className="button small ghost"
                    aria-label={`Dismiss failed import of #${op.number}`}
                    onClick={() => dismiss(op)}
                  >
                    Dismiss
                  </button>
                </>
              }
            >
              {op.error}
            </Notice>
          </div>
        ))}
      {syncOutcome?.status === "failed" && (
        <div style={{ marginBottom: 14 }}>
          <Notice tone="danger" title={`Sync failed ${relativeTime(syncOutcome.finishedAt)}.`}>
            {syncOutcome.error}
          </Notice>
        </div>
      )}
      {state.health.pollError && state.health.pollError !== syncOutcome?.error && (
        <div style={{ marginBottom: 14 }}>
          <Notice tone="warn" title="Last poll failed.">
            {state.health.pollError}
          </Notice>
        </div>
      )}
      <div className="toolbar">
        <input
          className="input search"
          type="search"
          placeholder="Search title, author, branch"
          aria-label="Search pull requests"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="chips" role="group" aria-label="Filter by status">
          {filterOrder.map((f) => (
            <button
              key={f}
              type="button"
              className="chip"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "attention" ? "Needs attention" : statusLabel[f]}
              <span className="count">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>
      {state.prs.length === 0 ? (
        <div className="card empty">
          <h2>No pull requests yet</h2>
          <p>
            Open pull requests in {state.settings.repository} requesting a review from you or one of
            your teams will show up here. You can also import an open PR by URL.
          </p>
        </div>
      ) : (
        <div className="inbox-groups">
          {visibleTotal === 0 && (
            <p className="muted small" role="status">
              Nothing matches the current search or status filter in any group.
            </p>
          )}
          {inboxGroups.map((group) => {
            const { total, visible } = grouped[group.key];
            return (
              <details
                key={group.key}
                className="card inbox-group"
                open={disclosure[group.key]}
                onToggle={(e) => {
                  const open = e.currentTarget.open;
                  setDisclosure((d) => (d[group.key] === open ? d : { ...d, [group.key]: open }));
                }}
              >
                <summary>
                  <span className="caret" aria-hidden="true" />
                  <h2>{group.title}</h2>
                  <span className="count" aria-label={`${visible.length} of ${total} shown`}>
                    {narrowed && visible.length !== total ? `${visible.length} of ${total}` : total}
                  </span>
                </summary>
                {visible.length === 0 ? (
                  <p className="group-empty muted small">
                    {total === 0
                      ? group.empty
                      : "No pull requests in this group match the current search or status filter."}
                  </p>
                ) : (
                  <div className="pr-list" role="list" aria-label={group.title}>
                    {visible.map((pr) => {
                      const action = reviewAction(pr, !!syncing[pr.id]);
                      return (
                        <div key={pr.id} role="listitem" className="pr-row">
                          <a className="title truncate" href={hrefFor({ name: "pr", id: pr.id })}>
                            <span className="num">#{pr.number}</span>
                            {pr.title}
                          </a>
                          <div className="right">
                            {(pr.blockingCount > 0 || pr.nonBlockingCount > 0) && (
                              <span
                                className="counts"
                                aria-label={`${pr.blockingCount} blocking, ${pr.nonBlockingCount} non-blocking`}
                              >
                                {pr.blockingCount > 0 && (
                                  <span className="b">{pr.blockingCount} blocking</span>
                                )}
                                {pr.nonBlockingCount > 0 && (
                                  <span className="nb">{pr.nonBlockingCount} minor</span>
                                )}
                              </span>
                            )}
                            <StatusPill status={pr.status} />
                            <AutoSubmissionBadges state={pr.autoSubmission} />
                            <ViewerApprovalPill pr={pr} />
                            <ReviewControls
                              pr={pr}
                              onChange={async () => {
                                await refresh();
                              }}
                            />
                            {action &&
                              !pr.reviewJobs?.some(
                                (job) => job.status === "queued" || job.status === "running",
                              ) && (
                                <button
                                  type="button"
                                  className="button small row-action"
                                  aria-label={`${action.label} #${pr.number} ${pr.title}`}
                                  aria-busy={action.busy || undefined}
                                  disabled={!action.enabled}
                                  onClick={() => void review(pr)}
                                >
                                  {action.label}
                                </button>
                              )}
                          </div>
                          <div className="meta">
                            <span>{pr.author}</span>
                            <span className="mono truncate" style={{ maxWidth: 220 }}>
                              {pr.headRef}
                            </span>
                            <span className="diffstat">
                              <span className="add">+{pr.additions}</span>{" "}
                              <span className="del">-{pr.deletions}</span>
                            </span>
                            <span className="merge-hint" data-tone={mergeView(pr).tone}>
                              <span className="faint">Merge:</span> {mergeSummary(pr)}
                            </span>
                            {pr.imported && <span>imported</span>}
                            {pr.requested && pr.requestSource === "unknown" && (
                              <span
                                className="request-hint"
                                title="Requested, but whether directly or through a team is not recorded until the next review-request sync"
                              >
                                requested, type unknown
                              </span>
                            )}
                            <span>{ageLabel(pr)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
