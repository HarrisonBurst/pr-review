import { useCallback, useState } from "react";
import type {
  BacklogReviewPreview,
  BacklogReviewOutcome,
  BacklogReviewReason,
} from "../../../shared/contracts";
import { backlogReviewLimit } from "../../../shared/contracts";
import { api } from "../api/client";
import { Modal, Notice } from "./ui";

const reasons: Record<BacklogReviewReason | "head_changed", string> = {
  not_tracked: "No longer open or tracked",
  reviewed_head: "Current commit already reviewed",
  automation_off: "No active auto-review policy",
  busy: "Review work already pending",
  head_changed: "Head changed; refresh the backlog to select it again",
};

export function BacklogReview({ refresh }: { refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const [preview, setPreview] = useState<BacklogReviewPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<BacklogReviewOutcome[] | null>(null);

  const show = async () => {
    setOpen(true);
    setBusy(true);
    setPreview(null);
    setSelected([]);
    setError(null);
    setOutcomes(null);
    try {
      setPreview(await api.backlog());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const queue = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      setOutcomes(
        await api.reviewBacklog({
          selections: preview.entries
            .filter((item) => selected.includes(item.prId))
            .map(({ prId, headSha }) => ({ prId, headSha })),
        }),
      );
      await refresh();
    } catch (e) {
      setError(
        `Lost or failed queue response. Refresh the backlog before another action: ${String(e)}`,
      );
      await refresh();
    } finally {
      setBusy(false);
      setSelected([]);
    }
  };

  return (
    <>
      <button type="button" className="button" onClick={() => void show()}>
        Review backlog
      </button>
      {open && (
        <Modal
          title="Review backlog"
          onClose={close}
          footer={
            <>
              <button type="button" className="button" disabled={busy} onClick={() => void show()}>
                Refresh backlog
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || !selected.length || outcomes !== null || error !== null}
                aria-busy={busy || undefined}
                onClick={() => void queue()}
              >
                {busy ? "Loading..." : `Queue ${selected.length} local draft reviews`}
              </button>
            </>
          }
        >
          <p>
            Automation records a baseline first; it reviews later commits and requests, not the
            untouched backlog. Select up to {preview?.limit ?? backlogReviewLimit} open tracked PRs
            with an active auto-review policy and no successful full review of their current commit.
          </p>
          <p>
            This action refreshes each selection and uses the normal review queue and concurrency
            limit. Changed heads, closed or removed requests and busy PRs are skipped. These reviews
            create local drafts only, never automatic publication. Dangerous native tools remain
            unrestricted.
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
          {outcomes ? (
            <div role="status">
              <ul aria-label="Backlog outcomes">
                {outcomes.map((item) => (
                  <li key={item.prId}>
                    #{preview?.entries.find((entry) => entry.prId === item.prId)?.number}:{" "}
                    {item.status}
                    {" - "}
                    {reasons[item.message as keyof typeof reasons] ?? item.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : preview ? (
            <div className="stack">
              {!preview.entries.some((item) => item.reason === null) && (
                <p role="status">No eligible unreviewed backlog.</p>
              )}
              {preview.entries.map((item) => (
                <label key={item.prId} className="check-row">
                  <input
                    type="checkbox"
                    checked={selected.includes(item.prId)}
                    disabled={
                      busy ||
                      item.reason !== null ||
                      (selected.length >= preview.limit && !selected.includes(item.prId))
                    }
                    onChange={(e) =>
                      setSelected((current) =>
                        e.target.checked
                          ? [...current, item.prId]
                          : current.filter((id) => id !== item.prId),
                      )
                    }
                  />
                  <span>
                    #{item.number} {item.title}{" "}
                    <span className="mono">{item.headSha.slice(0, 7)}</span>
                    {item.reason && <span className="muted"> - {reasons[item.reason]}</span>}
                  </span>
                </label>
              ))}
            </div>
          ) : busy ? (
            <p role="status">Loading backlog...</p>
          ) : null}
        </Modal>
      )}
    </>
  );
}
