import { DatabaseSync } from "node:sqlite";
import type { RemotePullRequest } from "./adapters.js";
import {
  publicationOff,
  publicationState,
  type SubmissionRecovery,
} from "./publication.js";
import type {
  AutoSubmissionPolicy,
  AutoSubmissionState,
  DiscussionSnapshot,
} from "../shared/contracts.js";
import { emptyProgress, interruptProgress, pendingEntry } from "./progress.js";
import {
  defaultIntegrationSettings,
  normalizeIntegrationSettings,
} from "./integrations.js";
import { ensureDir, id, now } from "./util.js";
import {
  automationOverrideKeys,
  effectiveAutomation,
  inheritAutomation,
  type AppSettings,
  type HarnessSettings,
  type AutomationMode,
  type AutomationOverrides,
  type AutomationPolicy,
  type CommitSummary,
  type Finding,
  type Freshness,
  type MergeBlocker,
  type MergeObservation,
  type MergeReadiness,
  type PullRequest,
  type Question,
  type QuestionAnswer,
  type DiffSelection,
  type ReviewDraft,
  type ReviewResult,
  type ReviewRun,
  type RevisionProposal,
  type ReviewerSettings,
  type RunProgress,
  type IntegrationSessionSnapshot,
  type IntegrationSettings,
  type SettingsUpdate,
  type Submission,
  type SubmissionPreview,
} from "../shared/contracts.js";

interface SettingsRow {
  auto_submission_json: string | null;
  repository: string;
  polling_enabled: number;
  poll_commits: number;
  review_new_commits: number;
  poll_requests: number;
  review_requests: number;
  poll_interval_seconds: number;
  max_concurrent_reviews: number;
  integrations_json: string;
  harness_json: string | null;
  skill_path: string;
  reviewer_model: string | null;
  additional_instructions: string;
}

interface MergeReadinessRow {
  pr_id: string;
  head_sha: string;
  checked_at: string;
  state: MergeReadiness["state"];
  merge_state_status: string | null;
  blockers_json: string;
  checks_truncated: number;
  error: string | null;
  last_known_json: string | null;
}

interface PrRow {
  id: string;
  number: number;
  repository: string;
  url: string;
  title: string;
  body: string;
  author: string;
  author_avatar_url: string | null;
  head_sha: string;
  base_sha: string;
  head_ref: string;
  base_ref: string;
  state: PullRequest["state"];
  requested: number;
  requested_at: string | null;
  request_source: PullRequest["requestSource"];
  historical_request_source: PullRequest["historicalRequestSource"];
  viewer_approval_json: string | null;
  imported: number;
  created_at: string | null;
  updated_at: string;
  status: PullRequest["status"];
  blocking_count: number;
  non_blocking_count: number;
  additions: number;
  deletions: number;
  changed_files: number;
  last_reviewed_at: string | null;
  has_reviewed_head: number;
  has_review_history: number;
  diff: string;
  diff_truncated: number;
  automation_json: string;
  auto_commit_head: string | null;
  auto_requests_armed: number;
}

export interface AutomationState {
  commitHead: string | null;
  requestsArmed: boolean;
}

interface RunRow {
  cancellation_json: string | null;
  auto_submission_json: string | null;
  id: string;
  pr_id: string;
  kind: ReviewRun["kind"];
  trigger: ReviewRun["trigger"];
  request_event_id: string | null;
  status: ReviewRun["status"];
  head_sha: string;
  base_sha: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  log: string;
  reviewer_json: string;
  result_json: string | null;
  progress_json: string | null;
  integration_json: string;
}

export type RunSnapshot = RemotePullRequest;

interface DraftRow {
  auto_submission_json: string | null;
  id: string;
  pr_id: string;
  run_id: string;
  head_sha: string;
  version: number;
  overview: string;
  body: string;
  findings_json: string;
  verdict: ReviewDraft["verdict"];
  created_at: string;
  updated_at: string;
}

interface ProposalRow {
  id: string;
  pr_id: string;
  run_id: string;
  draft_id: string;
  source_draft_version: number;
  instructions: string;
  status: RevisionProposal["status"];
  result_json: string;
  created_at: string;
}

interface PreviewRow {
  authority_json: string | null;
  id: string;
  pr_id: string;
  draft_id: string;
  draft_version: number;
  payload_json: string;
  created_at: string;
}

interface SubmissionRow {
  id: string;
  pr_id: string;
  preview_id: string;
  status: Submission["status"];
  payload_json: string;
  github_review_id: string | null;
  url: string | null;
  error: string | null;
  created_at: string;
}

interface QuestionRow {
  id: string;
  pr_id: string;
  draft_id: string | null;
  parent_id: string | null;
  mode: Question["mode"];
  status: Question["status"];
  base_sha: string;
  head_sha: string;
  selection_json: string;
  file_diff: string;
  diff_truncated: number;
  question: string;
  answer_json: string | null;
  error: string | null;
  log: string;
  integration_json: string | null;
  reviewer_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobRow {
  id: string;
  kind: "review" | "revision";
  pr_id: string;
  run_id: string;
  payload_json: string;
  status: ReviewRun["status"];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface SyncMeta {
  initialized: boolean;
  lastPollAt: string | null;
  pollError: string | null;
}

const prProjection = `SELECT prs.*, EXISTS (
  SELECT 1 FROM runs WHERE runs.pr_id = prs.id AND runs.head_sha = prs.head_sha
    AND runs.kind = 'review' AND runs.status = 'completed' AND runs.result_json IS NOT NULL
) AS has_reviewed_head, (EXISTS (
  SELECT 1 FROM runs WHERE runs.pr_id = prs.id AND runs.kind = 'review'
    AND runs.status = 'completed' AND runs.result_json IS NOT NULL
) OR EXISTS (
  SELECT 1 FROM submissions WHERE submissions.pr_id = prs.id AND submissions.status = 'submitted'
)) AS has_review_history FROM prs`;

const json = (value: unknown) => JSON.stringify(value);
const parsed = <T>(value: string): T => JSON.parse(value) as T;

function legacyResult(value: string): string | null {
  const result = parsed<Record<string, unknown>>(value);
  if (typeof result.summary !== "string" || result.body !== undefined)
    return null;
  const { summary, ...rest } = result;
  return json({ overview: "", body: summary, ...rest });
}

const findingDefaults = (finding: Record<string, unknown>) => ({
  ...finding,
  side: finding.side ?? "RIGHT",
  startLine: finding.startLine ?? null,
  questionId: finding.questionId ?? null,
});

const draftsDdl = `
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
        run_id TEXT UNIQUE REFERENCES runs(id),
        head_sha TEXT NOT NULL,
        version INTEGER NOT NULL,
        overview TEXT NOT NULL,
        body TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        verdict TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        auto_submission_json TEXT
      );
      CREATE INDEX IF NOT EXISTS drafts_pr_idx ON drafts(pr_id);`;
const automationColumns = (policy: AutomationPolicy) => [
  policy.pollCommits ? 1 : 0,
  policy.reviewNewCommits ? 1 : 0,
  policy.pollRequests ? 1 : 0,
  policy.reviewRequests ? 1 : 0,
];
const legacyPolling = (policy: AutomationPolicy) =>
  policy.pollRequests && policy.reviewRequests ? 1 : 0;

function parseOverrides(value: string): AutomationOverrides {
  const stored = parsed<Partial<Record<string, AutomationMode>>>(value);
  const overrides = { ...inheritAutomation };
  for (const key of automationOverrideKeys)
    if (stored[key] === "on" || stored[key] === "off")
      overrides[key] = stored[key];
  return overrides;
}

export class AppDatabase {
  readonly sqlite: DatabaseSync;
  readonly migratedPrIds = new Set<string>();

  constructor(readonly databasePath: string) {
    this.sqlite = new DatabaseSync(databasePath);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        repository TEXT NOT NULL,
        polling_enabled INTEGER NOT NULL,
        poll_commits INTEGER NOT NULL DEFAULT 0,
        review_new_commits INTEGER NOT NULL DEFAULT 0,
        poll_requests INTEGER NOT NULL DEFAULT 0,
        review_requests INTEGER NOT NULL DEFAULT 0,
        poll_interval_seconds INTEGER NOT NULL,
        max_concurrent_reviews INTEGER NOT NULL DEFAULT 1,
        integrations_json TEXT NOT NULL DEFAULT '[]',
        skill_path TEXT NOT NULL,
        reviewer_model TEXT,
        additional_instructions TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        initialized INTEGER NOT NULL,
        last_poll_at TEXT,
        poll_error TEXT
      );
      CREATE TABLE IF NOT EXISTS prs (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        repository TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        author_avatar_url TEXT,
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        requested INTEGER NOT NULL,
        requested_at TEXT,
        request_source TEXT,
        historical_request_source TEXT,
        imported INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        blocking_count INTEGER NOT NULL,
        non_blocking_count INTEGER NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        changed_files INTEGER NOT NULL,
        last_reviewed_at TEXT,
        diff TEXT NOT NULL,
        diff_truncated INTEGER NOT NULL,
        automation_json TEXT NOT NULL DEFAULT '{}',
        auto_commit_head TEXT,
        auto_requests_armed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS request_events (
        event_id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
        head_sha TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        trigger TEXT NOT NULL,
        request_event_id TEXT,
        status TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        log TEXT NOT NULL,
        reviewer_json TEXT NOT NULL,
        result_json TEXT,
        progress_json TEXT,
        integration_json TEXT NOT NULL DEFAULT '{"boundary":"read-only-gateway","connections":[]}'
      );
      CREATE TABLE IF NOT EXISTS run_snapshots (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        pr_json TEXT NOT NULL,
        diff TEXT NOT NULL,
        diff_truncated INTEGER NOT NULL
      );
      ${draftsDdl}
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id),
        draft_id TEXT NOT NULL DEFAULT '',
        source_draft_version INTEGER NOT NULL,
        instructions TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS previews (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
        draft_id TEXT NOT NULL DEFAULT '',
        draft_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
        preview_id TEXT NOT NULL REFERENCES previews(id),
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        github_review_id TEXT,
        url TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
        draft_id TEXT,
        parent_id TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        selection_json TEXT NOT NULL,
        file_diff TEXT NOT NULL,
        diff_truncated INTEGER NOT NULL,
        question TEXT NOT NULL,
        answer_json TEXT,
        error TEXT,
        log TEXT NOT NULL DEFAULT '',
        integration_json TEXT,
        reviewer_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS questions_pr_idx ON questions(pr_id, created_at);
      CREATE TABLE IF NOT EXISTS head_checks (
        pr_id TEXT PRIMARY KEY REFERENCES prs(id) ON DELETE CASCADE,
        baseline TEXT NOT NULL,
        head TEXT NOT NULL,
        status TEXT NOT NULL,
        commits_json TEXT NOT NULL,
        truncated INTEGER NOT NULL,
        checked_at TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS merge_readiness (
        pr_id TEXT PRIMARY KEY REFERENCES prs(id) ON DELETE CASCADE,
        head_sha TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        state TEXT NOT NULL,
        merge_state_status TEXT,
        blockers_json TEXT NOT NULL,
        checks_truncated INTEGER NOT NULL,
        error TEXT,
        last_known_json TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_pr_idx ON runs(pr_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS request_events_pr_idx ON request_events(pr_id, seen_at DESC);
    `);
    this.migrate();
  }

  private columns(table: string): Set<string> {
    return new Set(
      (
        this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
  }

  private migrate(): void {
    for (const [table, column] of [
      ["settings", "auto_submission_json"],
      ["prs", "auto_submission_json"],
      ["runs", "auto_submission_json"],
      ["drafts", "auto_submission_json"],
      ["previews", "authority_json"],
      ["previews", "recovery_json"],
      ["run_snapshots", "discussion_json"],
      ["run_snapshots", "viewer_login"],
    ])
      if (!this.columns(table!).has(column!))
        this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS automatic_heads (
      pr_id TEXT NOT NULL REFERENCES prs(id), head_sha TEXT NOT NULL, submission_id TEXT NOT NULL,
      PRIMARY KEY (pr_id, head_sha)
    );`);
    if (!this.columns("runs").has("cancellation_json"))
      this.sqlite.exec("ALTER TABLE runs ADD COLUMN cancellation_json TEXT");
    if (!this.columns("meta").has("same_pass_submission")) {
      this.transaction(() => {
        this.sqlite.exec(
          "ALTER TABLE meta ADD COLUMN same_pass_submission INTEGER NOT NULL DEFAULT 1",
        );
        for (const pr of this.sqlite
          .prepare("SELECT id, auto_submission_json FROM prs")
          .all() as Array<{
          id: string;
          auto_submission_json: string | null;
        }>) {
          const state = pr.auto_submission_json
            ? parsed<AutoSubmissionState>(pr.auto_submission_json)
            : publicationState();
          const provenanceFailure =
            state.check?.status === "check_needed" &&
            /(?:automated inline provenance|automated inline identities)/i.test(
              state.check.message,
            );
          const stopped = this.sqlite
            .prepare(
              "SELECT 1 FROM runs WHERE pr_id = ? AND (status IN ('unqueued', 'cancelled') OR json_type(cancellation_json) = 'object')",
            )
            .get(pr.id);
          state.generation++;
          state.version++;
          state.reenableRequired =
            (!!state.evidence.length && state.reenableRequired) ||
            state.evidence.some((item) => !item.acknowledgment) ||
            (!!stopped && state.reenableRequired);
          if (provenanceFailure)
            state.failure = {
              step: "provenance",
              message: state.check!.message,
              draftId: null,
              at: state.check!.checkedAt,
            };
          this.savePublicationState(pr.id, state);
        }
      });
    }
    if (!this.columns("settings").has("poll_requests")) {
      this.sqlite.exec(`
        ALTER TABLE settings ADD COLUMN poll_commits INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE settings ADD COLUMN review_new_commits INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE settings ADD COLUMN poll_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE settings ADD COLUMN review_requests INTEGER NOT NULL DEFAULT 0;
        UPDATE settings SET poll_requests = polling_enabled, review_requests = polling_enabled;
      `);
    }
    if (!this.columns("settings").has("max_concurrent_reviews"))
      this.sqlite.exec(
        "ALTER TABLE settings ADD COLUMN max_concurrent_reviews INTEGER NOT NULL DEFAULT 1",
      );
    if (!this.columns("settings").has("harness_json"))
      this.sqlite.exec("ALTER TABLE settings ADD COLUMN harness_json TEXT");
    if (!this.columns("settings").has("integrations_json"))
      this.sqlite.exec(
        "ALTER TABLE settings ADD COLUMN integrations_json TEXT NOT NULL DEFAULT '[]'",
      );
    if (!this.columns("prs").has("automation_json"))
      this.sqlite.exec(`
        ALTER TABLE prs ADD COLUMN automation_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE prs ADD COLUMN auto_commit_head TEXT;
        ALTER TABLE prs ADD COLUMN auto_requests_armed INTEGER NOT NULL DEFAULT 0;
      `);
    if (!this.columns("prs").has("request_source"))
      this.sqlite.exec(`
        ALTER TABLE prs ADD COLUMN request_source TEXT;
        ALTER TABLE prs ADD COLUMN created_at TEXT;
      `);
    if (!this.columns("prs").has("historical_request_source"))
      this.transaction(() => {
        this.sqlite.exec(`
          ALTER TABLE prs ADD COLUMN historical_request_source TEXT;
          WITH evidence AS (
            SELECT id AS pr_id, request_source AS source FROM prs WHERE requested = 1
            UNION ALL
            SELECT runs.pr_id, json_extract(run_snapshots.pr_json, '$.requestSource')
            FROM run_snapshots JOIN runs ON runs.id = run_snapshots.run_id
            WHERE json_extract(run_snapshots.pr_json, '$.requested') = 1
          ), history AS (
            SELECT pr_id,
              MAX(source IN ('direct', 'both')) AS direct,
              MAX(source IN ('team', 'both')) AS team
            FROM evidence WHERE source IN ('direct', 'team', 'both') GROUP BY pr_id
          )
          UPDATE prs SET historical_request_source = (
            SELECT CASE WHEN direct = 1 AND team = 1 THEN 'both'
              WHEN direct = 1 THEN 'direct' ELSE 'team' END
            FROM history WHERE history.pr_id = prs.id
          );
        `);
      });
    if (!this.columns("prs").has("viewer_approval_json"))
      this.sqlite.exec("ALTER TABLE prs ADD COLUMN viewer_approval_json TEXT");
    if (!this.columns("prs").has("imported"))
      this.sqlite.exec(
        "ALTER TABLE prs ADD COLUMN imported INTEGER NOT NULL DEFAULT 0",
      );
    if (!this.columns("runs").has("progress_json"))
      this.sqlite.exec("ALTER TABLE runs ADD COLUMN progress_json TEXT");
    if (!this.columns("runs").has("integration_json"))
      this.sqlite.exec(
        'ALTER TABLE runs ADD COLUMN integration_json TEXT NOT NULL DEFAULT \'{"boundary":"read-only-gateway","connections":[]}\'',
      );
    if (!this.columns("questions").has("integration_json"))
      this.sqlite.exec(
        "ALTER TABLE questions ADD COLUMN integration_json TEXT",
      );
    if (!this.columns("questions").has("reviewer_json"))
      this.sqlite.exec("ALTER TABLE questions ADD COLUMN reviewer_json TEXT");
    if (!this.columns("merge_readiness").has("last_known_json"))
      this.sqlite.exec(
        "ALTER TABLE merge_readiness ADD COLUMN last_known_json TEXT",
      );
    if (!this.columns("drafts").has("overview"))
      this.transaction(() => this.migrateLegacyDrafts());
    if (this.draftRunRequired())
      this.transaction(() => this.allowManualDrafts());
    this.transaction(() => {
      this.dropLegacyPollingOverrides();
      this.relinkLegacyRevisedDrafts();
      this.backfillRunDrafts();
      this.backfillFindingAnchors();
    });
  }

  private draftRunRequired(): boolean {
    const row = this.sqlite
      .prepare(
        "SELECT \"notnull\" AS required FROM pragma_table_info('drafts') WHERE name = 'run_id'",
      )
      .get() as { required: number } | undefined;
    return row?.required === 1;
  }

  private allowManualDrafts(): void {
    this.sqlite.exec(`
      ALTER TABLE drafts RENAME TO drafts_required_run;
      ${draftsDdl}
      INSERT INTO drafts SELECT * FROM drafts_required_run;
      DROP TABLE drafts_required_run;
    `);
  }

  private backfillFindingAnchors(): void {
    const drafts = this.sqlite
      .prepare(
        "SELECT id, findings_json FROM drafts WHERE findings_json NOT LIKE '%\"side\"%' AND findings_json != '[]'",
      )
      .all() as unknown as Array<{ id: string; findings_json: string }>;
    const updateDraft = this.sqlite.prepare(
      "UPDATE drafts SET findings_json = ? WHERE id = ?",
    );
    for (const row of drafts)
      updateDraft.run(
        json(
          parsed<Record<string, unknown>[]>(row.findings_json).map(
            findingDefaults,
          ),
        ),
        row.id,
      );
    for (const table of ["runs", "proposals"]) {
      const rows = this.sqlite
        .prepare(
          `SELECT id, result_json FROM ${table} WHERE result_json IS NOT NULL AND result_json NOT LIKE '%"side"%' AND result_json LIKE '%"findings":[{%'`,
        )
        .all() as unknown as Array<{ id: string; result_json: string }>;
      const update = this.sqlite.prepare(
        `UPDATE ${table} SET result_json = ? WHERE id = ?`,
      );
      for (const row of rows) {
        const result = parsed<Record<string, unknown>>(row.result_json);
        update.run(
          json({
            ...result,
            findings: (result.findings as Record<string, unknown>[]).map(
              findingDefaults,
            ),
          }),
          row.id,
        );
      }
    }
  }

  private dropLegacyPollingOverrides(): void {
    const rows = this.sqlite
      .prepare(
        `SELECT id, automation_json FROM prs
         WHERE automation_json LIKE '%"pollCommits"%' OR automation_json LIKE '%"pollRequests"%'`,
      )
      .all() as unknown as Array<{ id: string; automation_json: string }>;
    for (const row of rows)
      this.setPrAutomation(row.id, parseOverrides(row.automation_json));
  }

  private relinkLegacyRevisedDrafts(): void {
    const rows = this.sqlite
      .prepare(
        `SELECT drafts.id, drafts.pr_id, (
           SELECT group_concat(reviews.id) FROM runs AS reviews
           LEFT JOIN drafts AS owned ON owned.run_id = reviews.id
           WHERE reviews.pr_id = drafts.pr_id AND reviews.kind = 'review' AND reviews.status = 'completed'
             AND reviews.result_json IS NOT NULL AND reviews.head_sha = drafts.head_sha
             AND reviews.finished_at <= runs.created_at AND owned.id IS NULL
         ) AS origins
         FROM drafts JOIN runs ON runs.id = drafts.run_id WHERE runs.kind = 'revision'`,
      )
      .all() as unknown as Array<{
      id: string;
      pr_id: string;
      origins: string | null;
    }>;
    const relink = this.sqlite.prepare(
      "UPDATE drafts SET run_id = ? WHERE id = ?",
    );
    for (const row of rows) {
      this.migratedPrIds.add(row.pr_id);
      const origins = row.origins?.split(",") ?? [];
      if (origins.length === 1) relink.run(origins[0], row.id);
    }
  }

  private migrateLegacyDrafts(): void {
    this.sqlite.exec(`
      ALTER TABLE drafts RENAME TO drafts_legacy;
      ${draftsDdl}
      INSERT INTO drafts (id, pr_id, run_id, head_sha, version, overview, body, findings_json, verdict, created_at, updated_at)
        SELECT id, pr_id, run_id, head_sha, version, '', summary, findings_json, verdict, updated_at, updated_at FROM drafts_legacy;
      ALTER TABLE proposals ADD COLUMN draft_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE previews ADD COLUMN draft_id TEXT NOT NULL DEFAULT '';
      UPDATE proposals SET draft_id = (SELECT id FROM drafts_legacy WHERE drafts_legacy.pr_id = proposals.pr_id);
      UPDATE previews SET draft_id = (SELECT id FROM drafts_legacy WHERE drafts_legacy.pr_id = previews.pr_id);
      DROP TABLE drafts_legacy;
    `);
    for (const table of ["runs", "proposals"]) {
      const rows = this.sqlite
        .prepare(
          `SELECT id, result_json FROM ${table} WHERE result_json IS NOT NULL`,
        )
        .all() as unknown as Array<{ id: string; result_json: string }>;
      const update = this.sqlite.prepare(
        `UPDATE ${table} SET result_json = ? WHERE id = ?`,
      );
      for (const row of rows) {
        const migrated = legacyResult(row.result_json);
        if (migrated) update.run(migrated, row.id);
      }
    }
  }

  private backfillRunDrafts(): void {
    const rows = this.sqlite
      .prepare(
        `SELECT runs.id, runs.pr_id, runs.head_sha, runs.finished_at, runs.result_json FROM runs
         LEFT JOIN drafts ON drafts.run_id = runs.id
         WHERE runs.kind = 'review' AND runs.status = 'completed' AND runs.result_json IS NOT NULL AND drafts.id IS NULL`,
      )
      .all() as unknown as Array<{
      id: string;
      pr_id: string;
      head_sha: string;
      finished_at: string | null;
      result_json: string;
    }>;
    for (const row of rows) {
      const result = parsed<ReviewResult>(row.result_json);
      const createdAt = row.finished_at ?? now();
      this.migratedPrIds.add(row.pr_id);
      this.createDraft(
        {
          id: id(),
          runId: row.id,
          headSha: row.head_sha,
          version: 1,
          overview: result.overview,
          body: result.body,
          findings: result.findings,
          verdict: result.verdict,
          createdAt,
          updatedAt: createdAt,
        },
        row.pr_id,
      );
    }
  }

  static async open(databasePath: string): Promise<AppDatabase> {
    await ensureDir(
      databasePath.slice(0, databasePath.lastIndexOf("/")) || ".",
    );
    return new AppDatabase(databasePath);
  }

  close(): void {
    this.sqlite.close();
  }

  transaction<T>(fn: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.sqlite.exec("COMMIT");
      return value;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  initializeSettings(defaults: AppSettings): void {
    this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO settings
      (id, repository, polling_enabled, poll_commits, review_new_commits, poll_requests, review_requests,
       poll_interval_seconds, max_concurrent_reviews, integrations_json, skill_path, reviewer_model, additional_instructions, harness_json)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        defaults.repository,
        legacyPolling(defaults.automation),
        ...automationColumns(defaults.automation),
        defaults.pollIntervalSeconds,
        defaults.maxConcurrentReviews,
        json(defaults.integrations),
        defaults.reviewer.skillPath,
        defaults.reviewer.model,
        defaults.reviewer.additionalInstructions,
        defaults.harness ? json(defaults.harness) : null,
      );
    this.sqlite
      .prepare("INSERT OR IGNORE INTO meta (id, initialized) VALUES (1, 0)")
      .run();
  }

  getSettings(): AppSettings {
    const row = this.sqlite
      .prepare("SELECT * FROM settings WHERE id = 1")
      .get() as unknown as SettingsRow;
    return {
      repository: row.repository,
      autoSubmission: row.auto_submission_json
        ? parsed<AutoSubmissionPolicy>(row.auto_submission_json)
        : publicationOff(row.repository),
      automation: {
        pollCommits: row.poll_commits === 1,
        reviewNewCommits: row.review_new_commits === 1,
        pollRequests: row.poll_requests === 1,
        reviewRequests: row.review_requests === 1,
      },
      pollIntervalSeconds: row.poll_interval_seconds,
      maxConcurrentReviews: row.max_concurrent_reviews,
      integrations: normalizeIntegrationSettings(
        parsed<IntegrationSettings>(
          row.integrations_json || JSON.stringify(defaultIntegrationSettings()),
        ),
      ),
      harness: row.harness_json
        ? parsed<HarnessSettings>(row.harness_json)
        : { selection: null, sources: [] },
      reviewer: {
        skillPath: row.skill_path,
        model: row.reviewer_model,
        additionalInstructions: row.additional_instructions,
      },
    };
  }

  updateSettings(update: SettingsUpdate): AppSettings {
    const current = this.getSettings();
    const automation = { ...current.automation, ...update.automation };
    if (
      update.repository !== undefined &&
      update.repository.toLowerCase() !== current.repository.toLowerCase()
    ) {
      for (const pr of this.listPrs()) {
        if (pr.repository.toLowerCase() !== current.repository.toLowerCase())
          continue;
        const state = this.getPublicationState(pr.id);
        this.savePublicationState(pr.id, {
          ...state,
          version: state.version + 1,
          generation: state.generation + 1,
        });
      }
      this.savePublicationPolicy(publicationOff(update.repository));
    }
    this.sqlite
      .prepare(
        `UPDATE settings SET repository = ?, polling_enabled = ?, poll_commits = ?, review_new_commits = ?,
         poll_requests = ?, review_requests = ?, poll_interval_seconds = ?, max_concurrent_reviews = ? WHERE id = 1`,
      )
      .run(
        update.repository ?? current.repository,
        legacyPolling(automation),
        ...automationColumns(automation),
        update.pollIntervalSeconds ?? current.pollIntervalSeconds,
        update.maxConcurrentReviews ?? current.maxConcurrentReviews,
      );
    return this.getSettings();
  }

  savePublicationPolicy(policy: AutoSubmissionPolicy): void {
    this.sqlite
      .prepare("UPDATE settings SET auto_submission_json = ? WHERE id = 1")
      .run(json(policy));
  }

  getPublicationState(prId: string): AutoSubmissionState {
    const row = this.sqlite
      .prepare("SELECT auto_submission_json FROM prs WHERE id = ?")
      .get(prId) as { auto_submission_json: string | null } | undefined;
    return row?.auto_submission_json
      ? parsed<AutoSubmissionState>(row.auto_submission_json)
      : publicationState();
  }

  savePublicationState(prId: string, state: AutoSubmissionState): void {
    this.sqlite
      .prepare("UPDATE prs SET auto_submission_json = ? WHERE id = ?")
      .run(json(state), prId);
  }

  claimAutomaticHead(prId: string, head: string, submissionId: string): void {
    this.sqlite
      .prepare(
        "INSERT INTO automatic_heads (pr_id, head_sha, submission_id) VALUES (?, ?, ?)",
      )
      .run(prId, head, submissionId);
  }

  automaticHeadClaimed(prId: string, head: string): boolean {
    return !!this.sqlite
      .prepare("SELECT 1 FROM automatic_heads WHERE pr_id = ? AND head_sha = ?")
      .get(prId, head);
  }

  saveRecovery(previewId: string, recovery: SubmissionRecovery): void {
    this.sqlite
      .prepare("UPDATE previews SET recovery_json = ? WHERE id = ?")
      .run(json(recovery), previewId);
  }

  getRecovery(previewId: string): SubmissionRecovery | null {
    const row = this.sqlite
      .prepare("SELECT recovery_json FROM previews WHERE id = ?")
      .get(previewId) as { recovery_json: string | null } | undefined;
    return row?.recovery_json
      ? parsed<SubmissionRecovery>(row.recovery_json)
      : null;
  }

  updateHarness(settings: HarnessSettings): void {
    this.sqlite
      .prepare("UPDATE settings SET harness_json = ? WHERE id = 1")
      .run(json(settings));
  }

  updateIntegrations(settings: IntegrationSettings): IntegrationSettings {
    const normalized = normalizeIntegrationSettings(settings);
    this.sqlite
      .prepare("UPDATE settings SET integrations_json = ? WHERE id = 1")
      .run(json(normalized));
    return normalized;
  }

  getSyncMeta(): SyncMeta {
    const row = this.sqlite
      .prepare(
        "SELECT initialized, last_poll_at, poll_error FROM meta WHERE id = 1",
      )
      .get() as {
      initialized: number;
      last_poll_at: string | null;
      poll_error: string | null;
    };
    return {
      initialized: row.initialized === 1,
      lastPollAt: row.last_poll_at,
      pollError: row.poll_error,
    };
  }

  setSyncMeta(update: Partial<SyncMeta>): void {
    const current = this.getSyncMeta();
    this.sqlite
      .prepare(
        "UPDATE meta SET initialized = ?, last_poll_at = ?, poll_error = ? WHERE id = 1",
      )
      .run(
        update.initialized === undefined
          ? current.initialized
            ? 1
            : 0
          : update.initialized
            ? 1
            : 0,
        update.lastPollAt === undefined
          ? current.lastPollAt
          : update.lastPollAt,
        update.pollError === undefined ? current.pollError : update.pollError,
      );
  }

  upsertPr(pr: PullRequest, diff: string, diffTruncated: boolean): PullRequest {
    this.sqlite
      .prepare(
        `INSERT INTO prs (
      id, number, repository, url, title, body, author, author_avatar_url, head_sha, base_sha, head_ref, base_ref,
      state, requested, requested_at, request_source, historical_request_source, created_at, updated_at, status, blocking_count, non_blocking_count,
      additions, deletions, changed_files, last_reviewed_at, diff, diff_truncated, viewer_approval_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET number=excluded.number, repository=excluded.repository, url=excluded.url, title=excluded.title,
      body=excluded.body, author=excluded.author, author_avatar_url=excluded.author_avatar_url, head_sha=excluded.head_sha,
      base_sha=excluded.base_sha, head_ref=excluded.head_ref, base_ref=excluded.base_ref, state=excluded.state,
      requested=excluded.requested, requested_at=excluded.requested_at, request_source=excluded.request_source,
      historical_request_source=CASE
        WHEN excluded.historical_request_source IS NULL THEN prs.historical_request_source
        WHEN prs.historical_request_source IS NULL OR prs.historical_request_source = excluded.historical_request_source
          THEN excluded.historical_request_source
        ELSE 'both' END,
      created_at=COALESCE(excluded.created_at, prs.created_at), updated_at=excluded.updated_at, status=excluded.status,
      blocking_count=excluded.blocking_count, non_blocking_count=excluded.non_blocking_count, additions=excluded.additions,
      deletions=excluded.deletions, changed_files=excluded.changed_files, diff=excluded.diff, diff_truncated=excluded.diff_truncated,
      viewer_approval_json=excluded.viewer_approval_json`,
      )
      .run(
        pr.id,
        pr.number,
        pr.repository,
        pr.url,
        pr.title,
        pr.body,
        pr.author,
        pr.authorAvatarUrl,
        pr.headSha,
        pr.baseSha,
        pr.headRef,
        pr.baseRef,
        pr.state,
        pr.requested ? 1 : 0,
        pr.requestedAt,
        pr.requested ? pr.requestSource : null,
        pr.requested && pr.requestSource !== "unknown"
          ? pr.requestSource
          : null,
        pr.createdAt,
        pr.updatedAt,
        pr.status,
        pr.blockingCount,
        pr.nonBlockingCount,
        pr.additions,
        pr.deletions,
        pr.changedFiles,
        pr.lastReviewedAt,
        diff,
        diffTruncated ? 1 : 0,
        pr.viewerApproval ? json(pr.viewerApproval) : null,
      );
    return this.getPr(pr.id)!;
  }

  clearViewerApproval(prId: string): void {
    this.sqlite
      .prepare("UPDATE prs SET viewer_approval_json = NULL WHERE id = ?")
      .run(prId);
  }

  getPr(prId: string): PullRequest | null {
    const row = this.getPrRow(prId);
    return row
      ? this.toPr(row, this.getSettings().automation, this.readinessRows())
      : null;
  }

  getPrRow(prId: string): PrRow | null {
    return (
      (this.sqlite.prepare(`${prProjection} WHERE id = ?`).get(prId) as
        PrRow | undefined) ?? null
    );
  }

  listPrs(): PullRequest[] {
    const global = this.getSettings().automation;
    const readiness = this.readinessRows();
    return this.listPrRows().map((row) => this.toPr(row, global, readiness));
  }

  listPrRows(): PrRow[] {
    return this.sqlite
      .prepare(`${prProjection} ORDER BY updated_at DESC, id`)
      .all() as unknown as PrRow[];
  }

  listInboxPrs(): PullRequest[] {
    const global = this.getSettings().automation;
    const readiness = this.readinessRows();
    return (
      this.sqlite
        .prepare(
          `${prProjection} WHERE state = 'OPEN' AND (requested = 1 OR imported = 1 OR has_review_history = 1) ORDER BY updated_at DESC, id`,
        )
        .all() as unknown as PrRow[]
    ).map((row) => this.toPr(row, global, readiness));
  }

  private readinessRows(): Map<string, MergeReadiness> {
    return new Map(
      (
        this.sqlite
          .prepare("SELECT * FROM merge_readiness")
          .all() as unknown as MergeReadinessRow[]
      ).map((row) => [
        row.pr_id,
        {
          headSha: row.head_sha,
          checkedAt: row.checked_at,
          state: row.state,
          mergeStateStatus: row.merge_state_status,
          blockers: parsed<MergeBlocker[]>(row.blockers_json),
          checksTruncated: row.checks_truncated === 1,
          error: row.error,
          lastKnown: row.last_known_json
            ? parsed<MergeObservation>(row.last_known_json)
            : null,
        },
      ]),
    );
  }

  setMergeReadiness(prId: string, readiness: MergeReadiness): void {
    this.sqlite
      .prepare(
        `INSERT INTO merge_readiness (pr_id, head_sha, checked_at, state, merge_state_status, blockers_json, checks_truncated, error, last_known_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pr_id) DO UPDATE SET head_sha=excluded.head_sha, checked_at=excluded.checked_at, state=excluded.state,
        merge_state_status=excluded.merge_state_status, blockers_json=excluded.blockers_json,
        checks_truncated=excluded.checks_truncated, error=excluded.error, last_known_json=excluded.last_known_json`,
      )
      .run(
        prId,
        readiness.headSha,
        readiness.checkedAt,
        readiness.state,
        readiness.mergeStateStatus,
        json(readiness.blockers),
        readiness.checksTruncated ? 1 : 0,
        readiness.error,
        readiness.lastKnown ? json(readiness.lastKnown) : null,
      );
  }

  markImported(prId: string): void {
    this.sqlite.prepare("UPDATE prs SET imported = 1 WHERE id = ?").run(prId);
  }

  setPrStatus(prId: string, status: PullRequest["status"]): void {
    this.sqlite
      .prepare("UPDATE prs SET status = ? WHERE id = ?")
      .run(status, prId);
  }

  clearPrRequest(prId: string): void {
    this.sqlite
      .prepare(
        "UPDATE prs SET requested = 0, requested_at = NULL, request_source = NULL WHERE id = ?",
      )
      .run(prId);
  }

  setPrAutomation(prId: string, overrides: AutomationOverrides): void {
    this.sqlite
      .prepare("UPDATE prs SET automation_json = ? WHERE id = ?")
      .run(json(overrides), prId);
  }

  getAutomationState(prId: string): AutomationState {
    const row = this.getPrRow(prId);
    return {
      commitHead: row?.auto_commit_head ?? null,
      requestsArmed: row?.auto_requests_armed === 1,
    };
  }

  setCommitHead(prId: string, head: string | null): void {
    this.sqlite
      .prepare("UPDATE prs SET auto_commit_head = ? WHERE id = ?")
      .run(head, prId);
  }

  setRequestsArmed(prId: string, armed: boolean): void {
    this.sqlite
      .prepare("UPDATE prs SET auto_requests_armed = ? WHERE id = ?")
      .run(armed ? 1 : 0, prId);
  }

  setPrReviewTimestamp(prId: string, reviewedAt: string): void {
    this.sqlite
      .prepare("UPDATE prs SET last_reviewed_at = ? WHERE id = ?")
      .run(reviewedAt, prId);
  }

  updatePrCounts(
    prId: string,
    blockingCount: number,
    nonBlockingCount: number,
  ): void {
    this.sqlite
      .prepare(
        "UPDATE prs SET blocking_count = ?, non_blocking_count = ? WHERE id = ?",
      )
      .run(blockingCount, nonBlockingCount, prId);
  }

  insertRequestEvent(
    eventId: string,
    prId: string,
    headSha: string,
    requestedAt: string,
  ): boolean {
    const result = this.sqlite
      .prepare(
        "INSERT OR IGNORE INTO request_events (event_id, pr_id, head_sha, requested_at, seen_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(eventId, prId, headSha, requestedAt, now());
    return result.changes === 1;
  }

  latestRequestEventAt(prId: string): string | null {
    const row = this.sqlite
      .prepare(
        "SELECT MAX(requested_at) AS requested_at FROM request_events WHERE pr_id = ?",
      )
      .get(prId) as { requested_at: string | null };
    return row.requested_at;
  }

  hasRequestEvent(eventId: string): boolean {
    return Boolean(
      this.sqlite
        .prepare("SELECT 1 FROM request_events WHERE event_id = ?")
        .get(eventId),
    );
  }

  createRun(run: ReviewRun): void {
    const skill = run.reviewer.skillExecution;
    if (skill?.version === 3)
      run = {
        ...run,
        progress: {
          ...(run.progress ?? emptyProgress()),
          entries: [...skill.roles.additional, skill.roles.main].map(
            pendingEntry,
          ),
        },
      };
    this.sqlite
      .prepare(
        `INSERT INTO runs
      (id, pr_id, kind, trigger, request_event_id, status, head_sha, base_sha, created_at, started_at, finished_at, error, log, reviewer_json, result_json, progress_json, integration_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.prId,
        run.kind,
        run.trigger,
        run.requestEventId,
        run.status,
        run.headSha,
        run.baseSha,
        run.createdAt,
        run.startedAt,
        run.finishedAt,
        run.error,
        run.log,
        json(run.reviewer),
        run.result ? json(run.result) : null,
        run.progress ? json(run.progress) : null,
        json(
          run.integrationSnapshot ?? {
            boundary: "read-only-gateway",
            connections: [],
          },
        ),
      );
    this.sqlite
      .prepare(
        "UPDATE runs SET auto_submission_json = ?, cancellation_json = ? WHERE id = ?",
      )
      .run(
        json(run.autoSubmission ?? null),
        run.cancellation === undefined ? null : json(run.cancellation),
        run.id,
      );
  }

  getRun(runId: string): ReviewRun | null {
    const row = this.sqlite
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    return row ? this.toRun(row) : null;
  }

  createRunSnapshot(runId: string, snapshot: RunSnapshot): void {
    this.sqlite
      .prepare(
        "INSERT INTO run_snapshots (run_id, pr_json, diff, diff_truncated, viewer_login) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        json(snapshot.pr),
        snapshot.diff,
        snapshot.diffTruncated ? 1 : 0,
        snapshot.viewerLogin ?? null,
      );
  }

  captureRunDiscussion(
    runId: string,
    discussion: DiscussionSnapshot | null,
  ): void {
    this.sqlite
      .prepare(
        "UPDATE run_snapshots SET discussion_json = ? WHERE run_id = ? AND discussion_json IS NULL",
      )
      .run(json(discussion), runId);
  }

  getRunDiscussion(runId: string): DiscussionSnapshot | null | undefined {
    const row = this.sqlite
      .prepare("SELECT discussion_json FROM run_snapshots WHERE run_id = ?")
      .get(runId) as { discussion_json: string | null } | undefined;
    return row?.discussion_json
      ? parsed<DiscussionSnapshot | null>(row.discussion_json)
      : undefined;
  }

  getRunSnapshot(runId: string): RunSnapshot | null {
    const row = this.sqlite
      .prepare(
        "SELECT pr_json, diff, diff_truncated, viewer_login FROM run_snapshots WHERE run_id = ?",
      )
      .get(runId) as
      | {
          pr_json: string;
          diff: string;
          diff_truncated: number;
          viewer_login: string | null;
        }
      | undefined;
    return row
      ? {
          ...(row.viewer_login ? { viewerLogin: row.viewer_login } : {}),
          pr: parsed<PullRequest>(row.pr_json),
          diff: row.diff,
          diffTruncated: row.diff_truncated === 1,
        }
      : null;
  }

  listRuns(prId: string): ReviewRun[] {
    return (
      this.sqlite
        .prepare("SELECT * FROM runs WHERE pr_id = ? ORDER BY created_at DESC")
        .all(prId) as unknown as RunRow[]
    ).map((row) => this.toRun(row));
  }

  updateRun(
    runId: string,
    update: Partial<
      Pick<
        ReviewRun,
        | "status"
        | "startedAt"
        | "finishedAt"
        | "error"
        | "log"
        | "result"
        | "progress"
        | "cancellation"
      >
    >,
  ): void {
    const current = this.getRun(runId);
    if (!current) throw new Error("review run not found");
    const next = { ...current, ...update };
    this.sqlite
      .prepare(
        `UPDATE runs SET status = ?, started_at = ?, finished_at = ?, error = ?, log = ?, result_json = ?, progress_json = ?, cancellation_json = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.startedAt,
        next.finishedAt,
        next.error,
        next.log,
        next.result ? json(next.result) : null,
        next.progress ? json(next.progress) : null,
        next.cancellation === undefined ? null : json(next.cancellation),
        runId,
      );
  }

  setRunProgress(runId: string, progress: RunProgress): void {
    this.sqlite
      .prepare("UPDATE runs SET progress_json = ? WHERE id = ?")
      .run(json(progress), runId);
  }

  createDraft(draft: ReviewDraft, prId: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO drafts (id, pr_id, run_id, head_sha, version, overview, body, findings_json, verdict, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.id,
        prId,
        draft.runId,
        draft.headSha,
        draft.version,
        draft.overview,
        draft.body,
        json(draft.findings),
        draft.verdict,
        draft.createdAt,
        draft.updatedAt,
      );
    this.sqlite
      .prepare("UPDATE drafts SET auto_submission_json = ? WHERE id = ?")
      .run(
        json(draft.autoSubmission ?? { provenance: null, manualHold: null }),
        draft.id,
      );
  }

  getDraft(prId: string, draftId: string): ReviewDraft | null {
    const row = this.sqlite
      .prepare("SELECT * FROM drafts WHERE pr_id = ? AND id = ?")
      .get(prId, draftId) as DraftRow | undefined;
    return row ? this.toDraft(row) : null;
  }

  listDrafts(prId: string): ReviewDraft[] {
    return (
      this.sqlite
        .prepare(
          `SELECT drafts.* FROM drafts LEFT JOIN runs ON runs.id = drafts.run_id
           WHERE drafts.pr_id = ?
           ORDER BY COALESCE(runs.kind = 'revision', 0) ASC, COALESCE(runs.created_at, drafts.created_at) DESC, drafts.rowid DESC`,
        )
        .all(prId) as unknown as DraftRow[]
    ).map((row) => this.toDraft(row));
  }

  latestDraft(prId: string): ReviewDraft | null {
    return this.listDrafts(prId)[0] ?? null;
  }

  updateDraft(draft: ReviewDraft): void {
    this.sqlite
      .prepare(
        `UPDATE drafts SET version = ?, overview = ?, body = ?, findings_json = ?, verdict = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        draft.version,
        draft.overview,
        draft.body,
        json(draft.findings),
        draft.verdict,
        draft.updatedAt,
        draft.id,
      );
    this.sqlite
      .prepare("UPDATE drafts SET auto_submission_json = ? WHERE id = ?")
      .run(
        json(draft.autoSubmission ?? { provenance: null, manualHold: null }),
        draft.id,
      );
  }

  listProposals(prId: string): RevisionProposal[] {
    return (
      this.sqlite
        .prepare(
          "SELECT * FROM proposals WHERE pr_id = ? ORDER BY created_at DESC",
        )
        .all(prId) as unknown as ProposalRow[]
    ).map((row) => this.toProposal(row));
  }

  createProposal(proposal: RevisionProposal, prId: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO proposals (id, pr_id, run_id, draft_id, source_draft_version, instructions, status, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        prId,
        proposal.runId,
        proposal.draftId,
        proposal.sourceDraftVersion,
        proposal.instructions,
        proposal.status,
        json(proposal.result),
        proposal.createdAt,
      );
  }

  getProposal(proposalId: string): RevisionProposal | null {
    const row = this.sqlite
      .prepare("SELECT * FROM proposals WHERE id = ?")
      .get(proposalId) as ProposalRow | undefined;
    return row ? this.toProposal(row) : null;
  }

  setProposalStatus(
    proposalId: string,
    status: RevisionProposal["status"],
  ): void {
    this.sqlite
      .prepare("UPDATE proposals SET status = ? WHERE id = ?")
      .run(status, proposalId);
  }

  createPreview(preview: SubmissionPreview): void {
    this.sqlite
      .prepare(
        "INSERT INTO previews (id, pr_id, draft_id, draft_version, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        preview.id,
        preview.prId,
        preview.draftId,
        preview.draftVersion,
        json(preview.payload),
        preview.createdAt,
      );
    this.sqlite
      .prepare("UPDATE previews SET authority_json = ? WHERE id = ?")
      .run(json(preview.authority ?? { kind: "manual" }), preview.id);
  }

  getPreview(previewId: string): SubmissionPreview | null {
    const row = this.sqlite
      .prepare("SELECT * FROM previews WHERE id = ?")
      .get(previewId) as PreviewRow | undefined;
    return row
      ? {
          id: row.id,
          prId: row.pr_id,
          draftId: row.draft_id,
          draftVersion: row.draft_version,
          authority: row.authority_json
            ? parsed<SubmissionPreview["authority"]>(row.authority_json)
            : { kind: "manual" },
          payload: parsed<SubmissionPreview["payload"]>(row.payload_json),
          createdAt: row.created_at,
        }
      : null;
  }

  createSubmission(submission: Submission, prId: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO submissions (id, pr_id, preview_id, status, payload_json, github_review_id, url, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        submission.id,
        prId,
        submission.previewId,
        submission.status,
        json(submission.payload),
        submission.githubReviewId,
        submission.url,
        submission.error,
        submission.createdAt,
      );
  }

  getSubmission(submissionId: string): Submission | null {
    const row = this.sqlite
      .prepare("SELECT * FROM submissions WHERE id = ?")
      .get(submissionId) as SubmissionRow | undefined;
    return row ? this.toSubmission(row) : null;
  }

  getSubmissionForPreview(previewId: string): Submission | null {
    const row = this.sqlite
      .prepare(
        "SELECT * FROM submissions WHERE preview_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(previewId) as SubmissionRow | undefined;
    return row ? this.toSubmission(row) : null;
  }

  updateSubmission(submission: Submission): void {
    this.sqlite
      .prepare(
        `UPDATE submissions SET status = ?, payload_json = ?, github_review_id = ?, url = ?, error = ? WHERE id = ?`,
      )
      .run(
        submission.status,
        json(submission.payload),
        submission.githubReviewId,
        submission.url,
        submission.error,
        submission.id,
      );
  }

  listSubmissions(prId: string): Submission[] {
    return (
      this.sqlite
        .prepare(
          "SELECT * FROM submissions WHERE pr_id = ? ORDER BY created_at DESC",
        )
        .all(prId) as unknown as SubmissionRow[]
    ).map((row) => this.toSubmission(row));
  }

  createJob(job: JobRow): void {
    this.sqlite
      .prepare(
        `INSERT INTO jobs (id, kind, pr_id, run_id, payload_json, status, created_at, started_at, finished_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.kind,
        job.pr_id,
        job.run_id,
        job.payload_json,
        job.status,
        job.created_at,
        job.started_at,
        job.finished_at,
        job.error,
      );
  }

  getJob(jobId: string): JobRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
        JobRow | undefined) ?? null
    );
  }

  listJobs(status?: JobRow["status"], prId?: string): JobRow[] {
    const where = [status ? "status = ?" : "", prId ? "pr_id = ?" : ""].filter(
      Boolean,
    );
    return this.sqlite
      .prepare(
        `SELECT * FROM jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`,
      )
      .all(
        ...[status, prId].filter((value) => value !== undefined),
      ) as unknown as JobRow[];
  }

  updateJob(jobId: string, update: Partial<JobRow>): void {
    const current = this.getJob(jobId);
    if (!current) throw new Error("job not found");
    const next = { ...current, ...update };
    this.sqlite
      .prepare(
        `UPDATE jobs SET status = ?, started_at = ?, finished_at = ?, error = ? WHERE id = ?`,
      )
      .run(next.status, next.started_at, next.finished_at, next.error, jobId);
  }

  markInterruptedJobs(): void {
    this.sqlite
      .prepare(
        "UPDATE submissions SET status = 'uncertain', error = 'Backend stopped during a submission; exact reconciliation required' WHERE status = 'submitting'",
      )
      .run();
    const timestamp = now();
    for (const job of this.listJobs("running")) {
      const run = this.getRun(job.run_id);
      if (run?.cancellation)
        this.updateRun(run.id, {
          cancellation: {
            ...run.cancellation,
            status: "unconfirmed",
            finishedAt: timestamp,
            message: "Backend stopped before owned shutdown was confirmed",
          },
        });
    }
    this.sqlite
      .prepare(
        "UPDATE jobs SET status = 'interrupted', finished_at = ?, error = ? WHERE status = 'running'",
      )
      .run(timestamp, "Backend stopped while job was running");
    const running = this.sqlite
      .prepare(
        "SELECT id, progress_json FROM runs WHERE status = 'running' AND progress_json IS NOT NULL",
      )
      .all() as unknown as Array<{ id: string; progress_json: string }>;
    for (const row of running)
      this.setRunProgress(
        row.id,
        interruptProgress(parsed<RunProgress>(row.progress_json), timestamp),
      );
    this.sqlite
      .prepare(
        "UPDATE runs SET status = 'interrupted', finished_at = ?, error = ? WHERE status = 'running'",
      )
      .run(timestamp, "Backend stopped while review was running");
  }

  createQuestion(
    question: Question,
    fileDiff: string,
    diffTruncated: boolean,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO questions (id, pr_id, draft_id, parent_id, mode, status, base_sha, head_sha, selection_json, file_diff, diff_truncated, question, answer_json, error, log, integration_json, reviewer_json, created_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
      )
      .run(
        question.id,
        question.prId,
        question.draftId,
        question.parentId,
        question.mode,
        question.status,
        question.baseSha,
        question.headSha,
        json(question.selection),
        fileDiff,
        diffTruncated ? 1 : 0,
        question.question,
        question.answer ? json(question.answer) : null,
        question.error,
        json(
          question.integrationSnapshot ?? {
            boundary: "read-only-gateway",
            connections: [],
          },
        ),
        question.reviewerSnapshot ? json(question.reviewerSnapshot) : null,
        question.createdAt,
        question.startedAt,
        question.finishedAt,
      );
  }

  getQuestion(questionId: string): Question | null {
    const row = this.sqlite
      .prepare("SELECT * FROM questions WHERE id = ?")
      .get(questionId) as QuestionRow | undefined;
    return row ? this.toQuestion(row) : null;
  }

  getQuestionContext(
    questionId: string,
  ): { fileDiff: string; diffTruncated: boolean } | null {
    const row = this.sqlite
      .prepare("SELECT file_diff, diff_truncated FROM questions WHERE id = ?")
      .get(questionId) as
      { file_diff: string; diff_truncated: number } | undefined;
    return row
      ? { fileDiff: row.file_diff, diffTruncated: row.diff_truncated === 1 }
      : null;
  }

  listQuestions(prId: string): Question[] {
    return (
      this.sqlite
        .prepare(
          "SELECT * FROM questions WHERE pr_id = ? ORDER BY created_at, rowid",
        )
        .all(prId) as unknown as QuestionRow[]
    ).map((row) => this.toQuestion(row));
  }

  listQuestionsByStatus(status: Question["status"]): Question[] {
    return (
      this.sqlite
        .prepare(
          "SELECT * FROM questions WHERE status = ? ORDER BY created_at, rowid",
        )
        .all(status) as unknown as QuestionRow[]
    ).map((row) => this.toQuestion(row));
  }

  updateQuestion(
    questionId: string,
    update: Partial<
      Pick<Question, "status" | "answer" | "error" | "startedAt" | "finishedAt">
    > & { log?: string },
  ): void {
    const current = this.getQuestion(questionId);
    if (!current) throw new Error("question not found");
    const next = { ...current, ...update };
    this.sqlite
      .prepare(
        `UPDATE questions SET status = ?, answer_json = ?, error = ?, started_at = ?, finished_at = ?, log = COALESCE(?, log) WHERE id = ?`,
      )
      .run(
        next.status,
        next.answer ? json(next.answer) : null,
        next.error,
        next.startedAt,
        next.finishedAt,
        update.log ?? null,
        questionId,
      );
  }

  markInterruptedQuestions(): void {
    this.sqlite
      .prepare(
        "UPDATE questions SET status = 'interrupted', finished_at = ?, error = ? WHERE status IN ('running', 'queued')",
      )
      .run(now(), "Backend stopped before the question finished");
  }

  getFreshness(prId: string): Freshness | null {
    const row = this.sqlite
      .prepare("SELECT * FROM head_checks WHERE pr_id = ?")
      .get(prId) as
      | {
          baseline: string;
          head: string;
          status: Freshness["status"];
          commits_json: string;
          truncated: number;
          checked_at: string;
          error: string | null;
        }
      | undefined;
    return row
      ? {
          baseline: row.baseline,
          head: row.head,
          status: row.status,
          commits: parsed<CommitSummary[]>(row.commits_json),
          truncated: row.truncated === 1,
          checkedAt: row.checked_at,
          error: row.error,
        }
      : null;
  }

  setFreshness(prId: string, freshness: Freshness | null): void {
    if (!freshness) {
      this.sqlite.prepare("DELETE FROM head_checks WHERE pr_id = ?").run(prId);
      return;
    }
    this.sqlite
      .prepare(
        `INSERT INTO head_checks (pr_id, baseline, head, status, commits_json, truncated, checked_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pr_id) DO UPDATE SET baseline=excluded.baseline, head=excluded.head, status=excluded.status,
        commits_json=excluded.commits_json, truncated=excluded.truncated, checked_at=excluded.checked_at, error=excluded.error`,
      )
      .run(
        prId,
        freshness.baseline,
        freshness.head,
        freshness.status,
        json(freshness.commits),
        freshness.truncated ? 1 : 0,
        freshness.checkedAt,
        freshness.error,
      );
  }

  getDiff(prId: string): { diff: string; truncated: boolean } | null {
    const row = this.getPrRow(prId);
    return row ? { diff: row.diff, truncated: row.diff_truncated === 1 } : null;
  }

  private toPr(
    row: PrRow,
    global: AutomationPolicy,
    readiness: Map<string, MergeReadiness>,
  ): PullRequest {
    const automation = parseOverrides(row.automation_json);
    const approval = row.viewer_approval_json
      ? parsed<PullRequest["viewerApproval"]>(row.viewer_approval_json)
      : null;
    return {
      viewerApproval: approval?.headSha === row.head_sha ? approval : null,
      id: row.id,
      number: row.number,
      repository: row.repository,
      url: row.url,
      title: row.title,
      body: row.body,
      author: row.author,
      authorAvatarUrl: row.author_avatar_url,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      headRef: row.head_ref,
      baseRef: row.base_ref,
      state: row.state,
      requested: row.requested === 1,
      requestedAt: row.requested_at,
      requestSource:
        row.requested === 1 ? (row.request_source ?? "unknown") : null,
      historicalRequestSource: row.historical_request_source,
      imported: row.imported === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
      blockingCount: row.blocking_count,
      nonBlockingCount: row.non_blocking_count,
      additions: row.additions,
      deletions: row.deletions,
      changedFiles: row.changed_files,
      lastReviewedAt: row.last_reviewed_at,
      hasReviewedHead: row.has_reviewed_head === 1,
      hasReviewHistory: row.has_review_history === 1,
      mergeReadiness: readiness.get(row.id) ?? null,
      automation,
      effectiveAutomation: effectiveAutomation(global, automation),
    };
  }

  private toDraft(row: DraftRow): ReviewDraft {
    return {
      autoSubmission: row.auto_submission_json
        ? parsed<ReviewDraft["autoSubmission"]>(row.auto_submission_json)
        : { provenance: null, manualHold: null },
      id: row.id,
      runId: row.run_id,
      headSha: row.head_sha,
      version: row.version,
      overview: row.overview,
      body: row.body,
      findings: parsed<Finding[]>(row.findings_json),
      verdict: row.verdict,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toQuestion(row: QuestionRow): Question {
    return {
      id: row.id,
      prId: row.pr_id,
      draftId: row.draft_id,
      parentId: row.parent_id,
      mode: row.mode,
      status: row.status,
      baseSha: row.base_sha,
      headSha: row.head_sha,
      selection: parsed<DiffSelection>(row.selection_json),
      question: row.question,
      answer: row.answer_json ? parsed<QuestionAnswer>(row.answer_json) : null,
      error: row.error,
      integrationSnapshot: row.integration_json
        ? parsed<IntegrationSessionSnapshot>(row.integration_json)
        : { boundary: "read-only-gateway", connections: [] },
      reviewerSnapshot: row.reviewer_json
        ? parsed<ReviewerSettings>(row.reviewer_json)
        : undefined,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  private toProposal(row: ProposalRow): RevisionProposal {
    return {
      id: row.id,
      runId: row.run_id,
      draftId: row.draft_id,
      sourceDraftVersion: row.source_draft_version,
      instructions: row.instructions,
      status: row.status,
      result: parsed<ReviewResult>(row.result_json),
      createdAt: row.created_at,
    };
  }

  private toRun(row: RunRow): ReviewRun {
    return {
      ...(row.cancellation_json
        ? {
            cancellation: parsed<ReviewRun["cancellation"]>(
              row.cancellation_json,
            ),
          }
        : {}),
      autoSubmission: row.auto_submission_json
        ? parsed<ReviewRun["autoSubmission"]>(row.auto_submission_json)
        : null,
      id: row.id,
      prId: row.pr_id,
      kind: row.kind,
      trigger: row.trigger,
      requestEventId: row.request_event_id,
      status: row.status,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: row.error,
      log: row.log,
      reviewer: parsed<ReviewerSettings>(row.reviewer_json),
      integrationSnapshot: row.integration_json
        ? parsed<IntegrationSessionSnapshot>(row.integration_json)
        : { boundary: "read-only-gateway", connections: [] },
      result: row.result_json ? parsed<ReviewResult>(row.result_json) : null,
      progress: row.progress_json
        ? parsed<RunProgress>(row.progress_json)
        : null,
    };
  }

  private toSubmission(row: SubmissionRow): Submission {
    return {
      authority: this.getPreview(row.preview_id)?.authority ?? {
        kind: "manual",
      },
      id: row.id,
      previewId: row.preview_id,
      status: row.status,
      payload: parsed<Submission["payload"]>(row.payload_json),
      githubReviewId: row.github_review_id,
      url: row.url,
      error: row.error,
      createdAt: row.created_at,
    };
  }
}
