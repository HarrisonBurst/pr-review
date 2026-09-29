import type { Question } from "../../../shared/contracts";
import { describeSelection } from "../lib/diff";
import { ARCHIVED_LABEL, capturedExecution } from "../lib/execution";
import { relativeTime, shortSha } from "../lib/format";
import { CitedMarkdown, modeLabel, questionStatusLabel, rootOf, threadOf } from "./AskPanel";
import { Markdown } from "./Markdown";
import { Pill } from "./ui";

export function QuestionExecution({ question }: { question: Question }) {
  if (!question.reviewerSnapshot)
    return (
      <div className="small faint" data-testid="question-execution">
        {ARCHIVED_LABEL}: no captured execution. Retry or follow-up cannot use current Settings;
        save them and start an independent question.
      </div>
    );
  const execution = capturedExecution(question.reviewerSnapshot);
  return (
    <div className="small faint" data-testid="question-execution">
      {execution.label} · {execution.model} · captured when asked; follow-ups and retries keep it.
      {execution.archived
        ? " Not rerunnable: retry and follow-up are refused without changing the recorded answer; save current Settings and start an independent question."
        : execution.main
          ? " Questions invoke captured Main only, never Additional reviewers or the full review entry."
          : ""}
    </div>
  );
}

export function QuestionsCard({
  questions,
  headSha,
  paths,
  onShow,
}: {
  questions: Question[];
  headSha: string;
  paths: Set<string>;
  onShow: (questionId: string) => void;
}) {
  const roots = questions.filter((q) => rootOf(q, questions) === q.id).reverse();
  return (
    <section className="card" aria-labelledby="questions-h">
      <div className="card-head">
        <h2 id="questions-h">Questions</h2>
        <span className="small faint">{roots.length}</span>
      </div>
      <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
        <div className="runs">
          {roots.map((root) => {
            const thread = threadOf(root.id, questions);
            const last = thread[thread.length - 1]!;
            const current = root.headSha === headSha;
            return (
              <details className="run" key={root.id}>
                <summary aria-label={`${modeLabel[root.mode]} ${questionStatusLabel[last.status]}`}>
                  <div className="row between">
                    <span className="run-title">
                      {modeLabel[root.mode]}
                      {thread.length > 1 ? ` +${thread.length - 1}` : ""}
                    </span>
                    <Pill
                      tone={
                        last.status === "completed"
                          ? "ok"
                          : last.status === "failed"
                            ? "danger"
                            : last.status === "cancelled"
                              ? "neutral"
                              : last.status === "interrupted"
                                ? "warn"
                                : "accent"
                      }
                      live={last.status === "queued" || last.status === "running"}
                    >
                      {questionStatusLabel[last.status]}
                    </Pill>
                  </div>
                  <div className="run-meta small muted">
                    <span className="mono truncate">
                      {root.selection.path} · {describeSelection(root.selection)}
                    </span>
                    <span className="mono">{shortSha(root.headSha)}</span>
                    <span>{relativeTime(root.createdAt)}</span>
                  </div>
                  {!current && (
                    <div className="run-badges">
                      <Pill tone="warn">older commit</Pill>
                    </div>
                  )}
                </summary>
                <div className="run-detail stack" style={{ gap: 8 }}>
                  <QuestionExecution question={root} />
                  {thread.map((q) => (
                    <div key={q.id} className="small stack" style={{ gap: 4 }}>
                      {q.question && <p className="ask-q">{q.question}</p>}
                      {q.error && <p className="faint">{q.error}</p>}
                      {q.answer?.kind === "answer" && (
                        <CitedMarkdown source={q.answer.answer} paths={paths} />
                      )}
                      {q.answer?.kind === "comment" && (
                        <div className="stack" style={{ gap: 4 }}>
                          <span className="faint">Suggested comment ({q.answer.severity})</span>
                          <Markdown source={q.answer.body} />
                        </div>
                      )}
                    </div>
                  ))}
                  <div>
                    <button
                      type="button"
                      className="button small"
                      disabled={!current}
                      title={current ? undefined : "Asked on a commit other than the current diff"}
                      onClick={() => onShow(root.id)}
                    >
                      Show in diff
                    </button>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      </div>
    </section>
  );
}
