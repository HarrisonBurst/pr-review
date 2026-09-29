import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Components } from "react-markdown";
import type {
  CommentSide,
  DiffSelection,
  Finding,
  Question,
  QuestionMode,
  Severity,
} from "../../../shared/contracts";
import {
  anchorFor,
  anchorLabel,
  defaultAnchorSide,
  describeSelection,
  type Anchor,
} from "../lib/diff";
import { newFinding } from "../lib/draft";
import { jumpToDiff } from "../lib/jump";
import { relativeTime, shortSha } from "../lib/format";
import { Markdown } from "./Markdown";
import { AutoTextarea, Notice, Pill, Segmented, SeverityPill, type Tone } from "./ui";

export type AddTarget =
  | { kind: "open"; label: string }
  | { kind: "switch"; label: string; blocked: string | null }
  | { kind: "create"; blocked: string | null }
  | { kind: "stale"; message: string };

export type PanelView = "toolbar" | "compose" | "thread";

export const modeLabel: Record<QuestionMode, string> = {
  explain: "Explain",
  investigate: "Investigate",
  draft_comment: "Draft comment",
};

const statusTone: Record<Question["status"], Tone> = {
  queued: "info",
  running: "accent",
  completed: "ok",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warn",
};

export const questionStatusLabel: Record<Question["status"], string> = {
  queued: "Queued",
  running: "Thinking",
  completed: "Answered",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function rootOf(question: Question, all: Question[]): string {
  let current = question;
  const seen = new Set<string>();
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = all.find((q) => q.id === current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

export const threadOf = (rootId: string, all: Question[]) =>
  all.filter((q) => rootOf(q, all) === rootId);

const citation = /^([\w@./-]+\.[\w-]+):(\d+)(?:-(\d+))?(\s\(old\))?$/;

export function CitedMarkdown({ source, paths }: { source: string; paths: Set<string> }) {
  const [error, setError] = useState<string | null>(null);
  const components = useMemo<Components>(
    () => ({
      code: ({ node: _node, children, ...props }) => {
        const text = String(children);
        const match = citation.exec(text.trim());
        if (match && paths.has(match[1]!) && !("className" in props && props.className)) {
          const side: CommentSide = match[4] ? "LEFT" : "RIGHT";
          const line = Number(match[3] ?? match[2]);
          return (
            <button
              type="button"
              className="cite"
              onClick={() => setError(jumpToDiff(match[1]!, line, side))}
            >
              {text}
            </button>
          );
        }
        return <code {...props}>{children}</code>;
      },
    }),
    [paths],
  );
  return (
    <>
      <Markdown source={source} components={components} />
      {error && (
        <p className="finding-jump-error" role="status">
          {error}
        </p>
      )}
    </>
  );
}

export function SelectionProvenance({
  selection,
  stale,
}: {
  selection: DiffSelection;
  stale: boolean;
}) {
  return (
    <span className="ask-prov mono" aria-live="polite">
      <span className="ask-path">{selection.path}</span>
      {selection.oldPath && <span className="faint"> (was {selection.oldPath})</span>}
      <span> · {describeSelection(selection)}</span>
      <span title={`${selection.baseSha}..${selection.headSha}`}>
        {" "}
        · {shortSha(selection.baseSha)}..{shortSha(selection.headSha)}
      </span>
      {stale && <span className="faint"> · not the current head</span>}
    </span>
  );
}

interface AnchorChoice {
  key: string;
  label: string;
  anchor: Anchor | null;
}

function anchorChoices(selection: DiffSelection): AnchorChoice[] {
  const choices: AnchorChoice[] = [];
  const preferred = defaultAnchorSide(selection);
  for (const side of (preferred === "LEFT"
    ? ["LEFT", "RIGHT"]
    : ["RIGHT", "LEFT"]) as CommentSide[]) {
    const anchor = anchorFor(selection, side);
    if (anchor) choices.push({ key: side, label: anchorLabel(anchor), anchor });
  }
  choices.push({ key: "body", label: "review body only (no line)", anchor: null });
  return choices;
}

function anchorIssue(selection: DiffSelection): string | null {
  if (selection.spansHunks)
    return "This selection spans more than one hunk, so GitHub cannot anchor a single comment to it. Select lines within one hunk, or add it to the review body.";
  if (!selection.anchors.RIGHT && !selection.anchors.LEFT)
    return "These rows have no line numbers GitHub can anchor to, so the comment can only go in the review body.";
  if (
    selection.anchors.RIGHT &&
    selection.anchors.LEFT &&
    selection.kinds.add &&
    selection.kinds.del
  )
    return "The selection mixes removed and added lines. Pick which side the comment attaches to; GitHub cannot anchor one comment to both.";
  return null;
}

const addLabel = (target: AddTarget) =>
  target.kind === "open"
    ? "Add to draft"
    : target.kind === "switch"
      ? `Open ${target.label} and add`
      : target.kind === "create"
        ? "Create local draft and add"
        : "Add to draft";

const addBlocked = (target: AddTarget) =>
  target.kind === "stale"
    ? target.message
    : target.kind === "switch" || target.kind === "create"
      ? target.blocked
      : null;

export function CommentComposer({
  selection,
  initial,
  target,
  busy,
  onAdd,
  onCancel,
}: {
  selection: DiffSelection;
  initial: Partial<Finding> & { evidence?: string };
  target: AddTarget;
  busy: boolean;
  onAdd: (finding: Finding) => Promise<string | null>;
  onCancel: () => void;
}) {
  const choices = useMemo(() => anchorChoices(selection), [selection]);
  const [choice, setChoice] = useState(choices[0]!.key);
  const [body, setBody] = useState(initial.body ?? "");
  const [severity, setSeverity] = useState<Severity>(initial.severity ?? "non_blocking");
  const [origin, setOrigin] = useState<Finding["origin"]>(initial.origin ?? "introduced");
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    bodyRef.current?.focus({ preventScroll: true });
  }, []);
  const issue = anchorIssue(selection);
  const blocked = addBlocked(target);
  const chosen = choices.find((c) => c.key === choice) ?? choices[0]!;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim() || blocked) return;
    const finding = newFinding({
      body,
      severity,
      origin,
      path: selection.path,
      line: chosen.anchor?.line ?? null,
      startLine: chosen.anchor?.startLine ?? null,
      side: chosen.anchor?.side ?? "RIGHT",
      evidence: initial.evidence ?? "",
      questionId: initial.questionId ?? null,
    });
    setError(await onAdd(finding));
  };
  return (
    <form className="ask-compose" onSubmit={submit} aria-label="Comment composer">
      {issue && (
        <Notice tone="warn">
          <span className="small">{issue}</span>
        </Notice>
      )}
      <div className="field">
        <label htmlFor="ask-anchor">Attach to</label>
        <select
          id="ask-anchor"
          className="select"
          value={choice}
          disabled={busy}
          onChange={(e) => setChoice(e.target.value)}
        >
          {choices.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <Segmented<Severity>
          label="Severity"
          value={severity}
          disabled={busy}
          onChange={setSeverity}
          options={[
            { value: "blocking", label: "Blocking" },
            { value: "non_blocking", label: "Non-blocking" },
          ]}
        />
        <select
          className="select finding-origin"
          aria-label="Origin"
          value={origin}
          disabled={busy}
          onChange={(e) => setOrigin(e.target.value as Finding["origin"])}
        >
          <option value="introduced">Introduced here</option>
          <option value="pre_existing">Pre-existing</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="ask-body">
          Comment{" "}
          <span className="field-hint">posted to the author, editable later in the draft</span>
        </label>
        <AutoTextarea
          id="ask-body"
          ref={bodyRef}
          minRows={3}
          value={body}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      {initial.evidence !== undefined && (
        <div className="field">
          <span className="field-label" id="ask-evidence-label">
            Evidence <span className="field-hint">private, from Ask AI, read-only</span>
          </span>
          <div className="context" role="note" aria-labelledby="ask-evidence-label">
            {initial.evidence.trim() ? (
              <Markdown source={initial.evidence} />
            ) : (
              <p className="context-empty">No evidence was recorded.</p>
            )}
          </div>
        </div>
      )}
      {blocked && (
        <Notice tone="warn">
          <span className="small">{blocked}</span>
        </Notice>
      )}
      {error && (
        <Notice tone="danger">
          <span className="small">{error}</span>
        </Notice>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        <button
          type="submit"
          className="button primary small"
          disabled={busy || !body.trim() || !!blocked}
        >
          {addLabel(target)}
        </button>
        <button type="button" className="button ghost small" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="small faint">
          {chosen.anchor
            ? `Anchors to ${chosen.label}; nothing is posted until you submit the review.`
            : "Goes in the review body; nothing is posted until you submit the review."}
        </span>
      </div>
    </form>
  );
}

function Turn({
  question,
  paths,
  busy,
  onCancel,
  onRetry,
}: {
  question: Question;
  paths: Set<string>;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const live = question.status === "queued" || question.status === "running";
  return (
    <div className="ask-turn" data-status={question.status}>
      <div className="row wrap between">
        <span className="row wrap">
          <Pill tone="neutral" plain>
            {modeLabel[question.mode]}
          </Pill>
          <Pill tone={statusTone[question.status]} live={live}>
            {questionStatusLabel[question.status]}
          </Pill>
          <span className="small faint">{relativeTime(question.createdAt)}</span>
        </span>
        {live && (
          <button type="button" className="button ghost small" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
        {(question.status === "failed" ||
          question.status === "cancelled" ||
          question.status === "interrupted") && (
          <button type="button" className="button small" disabled={busy} onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
      {question.question && <p className="ask-q">{question.question}</p>}
      {question.error && (
        <p className="small" role={question.status === "failed" ? "alert" : "status"}>
          {question.error}
        </p>
      )}
      {question.answer?.kind === "answer" && (
        <div className="ask-answer" data-testid="ask-answer">
          <CitedMarkdown source={question.answer.answer} paths={paths} />
        </div>
      )}
    </div>
  );
}

export function AskPanel({
  selection,
  stale,
  paths,
  questions,
  initialThreadId,
  initialView,
  target,
  draftId,
  busy,
  onAsk,
  onCancel,
  onRetry,
  onAdd,
  onClose,
}: {
  selection: DiffSelection;
  stale: boolean;
  paths: Set<string>;
  questions: Question[];
  initialThreadId: string | null;
  initialView: PanelView;
  target: AddTarget;
  draftId: string | null;
  busy: boolean;
  onAsk: (mode: QuestionMode, question: string, parentId: string | null) => Promise<string | null>;
  onCancel: (questionId: string) => Promise<void>;
  onRetry: (questionId: string) => Promise<void>;
  onAdd: (finding: Finding) => Promise<string | null>;
  onClose: () => void;
}) {
  const [view, setView] = useState<PanelView>(initialView);
  const [threadId, setThreadId] = useState<string | null>(initialThreadId);
  const [text, setText] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  const [composeFrom, setComposeFrom] = useState<string | null>(null);
  const thread = useMemo(
    () => (threadId ? threadOf(threadId, questions) : []),
    [threadId, questions],
  );
  const last = thread[thread.length - 1] ?? null;
  const live = thread.some((q) => q.status === "queued" || q.status === "running");
  const comment = thread.findLast((q) => q.answer?.kind === "comment") ?? null;

  const ask = async (mode: QuestionMode, question: string) => {
    setAskError(null);
    const parent = view === "thread" && last ? last.id : null;
    try {
      const id = await onAsk(mode, question, parent);
      if (!id) return;
      setThreadId(parent ? threadId : id);
      setView("thread");
      setText("");
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e));
    }
  };

  const followUps = last?.answer?.kind === "answer" ? last.answer.followUps : [];
  const buttons = (
    <div className="ask-actions row wrap" role="group" aria-label="Ask AI">
      {(["explain", "investigate", "draft_comment"] as QuestionMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          className="button small"
          disabled={busy || live || stale}
          onClick={() => void ask(mode, text.trim())}
        >
          {view === "thread" && text.trim() ? `${modeLabel[mode]} follow-up` : modeLabel[mode]}
        </button>
      ))}
    </div>
  );

  return (
    <div
      className="ask"
      role="region"
      aria-label="Selected code actions"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="ask-head row wrap between">
        <SelectionProvenance selection={selection} stale={stale} />
        <button
          type="button"
          className="icon-button"
          aria-label="Clear selection"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {stale && (
        <Notice tone="warn">
          <span className="small">
            The pull request moved to a new commit after this was selected. Reselect on the current
            diff to ask or comment; earlier answers stay readable here.
          </span>
        </Notice>
      )}
      {view === "toolbar" && (
        <div className="ask-bar">
          <input
            className="input"
            aria-label="Optional question for Ask AI"
            placeholder="Optional question, e.g. why is this rounded before the discount?"
            value={text}
            disabled={busy || stale}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && text.trim()) void ask("explain", text.trim());
            }}
          />
          {buttons}
          <button
            type="button"
            className="button primary small"
            disabled={busy || stale}
            onClick={() => {
              setComposeFrom(null);
              setView("compose");
            }}
          >
            Add comment
          </button>
          <span className="small faint">
            Ask AI uses this exact commit. Dangerous host tools can publish independently.{" "}
            {draftId ? "" : "No draft is open yet."}
          </span>
        </div>
      )}
      {askError && (
        <Notice tone="danger">
          <span className="small">{askError}</span>
        </Notice>
      )}
      {view === "compose" && (
        <CommentComposer
          selection={selection}
          initial={
            composeFrom && comment?.answer?.kind === "comment"
              ? {
                  body: comment.answer.body,
                  severity: comment.answer.severity,
                  origin: comment.answer.origin,
                  evidence: comment.answer.evidence,
                  questionId: comment.id,
                }
              : {}
          }
          target={target}
          busy={busy}
          onAdd={onAdd}
          onCancel={() => setView(threadId ? "thread" : "toolbar")}
        />
      )}
      {view === "thread" && (
        <div className="ask-thread" data-testid="ask-thread">
          {thread.map((q) => (
            <Turn
              key={q.id}
              question={q}
              paths={paths}
              busy={busy}
              onCancel={() => void onCancel(q.id)}
              onRetry={() => void onRetry(q.id)}
            />
          ))}
          {comment?.answer?.kind === "comment" && comment === last && (
            <div className="ask-suggest" data-testid="ask-suggestion">
              <div className="row wrap between">
                <span className="row wrap">
                  <SeverityPill severity={comment.answer.severity} />
                  <span className="small faint">
                    {comment.answer.origin === "pre_existing" ? "pre-existing" : "introduced here"}
                  </span>
                </span>
                <button
                  type="button"
                  className="button primary small"
                  disabled={busy}
                  onClick={() => {
                    setComposeFrom(comment.id);
                    setView("compose");
                  }}
                >
                  Edit and add to draft
                </button>
              </div>
              <div className="ask-answer">
                <Markdown source={comment.answer.body} />
              </div>
              <details className="ask-evidence">
                <summary>Private evidence (never posted)</summary>
                <div className="context">
                  {comment.answer.evidence.trim() ? (
                    <CitedMarkdown source={comment.answer.evidence} paths={paths} />
                  ) : (
                    <p className="context-empty">No evidence was recorded.</p>
                  )}
                </div>
              </details>
            </div>
          )}
          {!stale && (
            <div className="ask-follow">
              {!live && followUps.length > 0 && (
                <div className="row wrap" style={{ gap: 6 }}>
                  {followUps.map((f) => (
                    <button
                      key={f}
                      type="button"
                      className="chip"
                      disabled={busy}
                      onClick={() => setText(f)}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
              <div className="ask-bar">
                <input
                  className="input"
                  aria-label="Follow-up question"
                  placeholder="Follow-up question about the same selection"
                  value={text}
                  disabled={busy || live}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && text.trim()) void ask("explain", text.trim());
                  }}
                />
                {buttons}
                <button
                  type="button"
                  className="button ghost small"
                  disabled={busy}
                  onClick={() => {
                    setComposeFrom(null);
                    setView("compose");
                  }}
                >
                  Add comment
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
