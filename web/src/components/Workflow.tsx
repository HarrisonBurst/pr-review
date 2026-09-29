import { useCallback, useEffect, useRef, useState } from "react";
import {
  dangerousConfirmation,
  executionModes,
  type ExecutionMode,
  type HarnessId,
  type HarnessSelectionUpdate,
  type HarnessStatus,
  type IsolatedCapabilityPolicy,
  validModel,
} from "../../../shared/contracts";
import { api, RequestError } from "../api/client";
import { useApp } from "../app-context";
import { harnessLabel, modeLabel } from "../lib/execution";
import { DockerRuntime } from "./Docker";
import { ModelSelect, type ModelDiscoveryState } from "./ModelSelect";
import { Modal, More, Notice, Pill, Segmented, Spinner, useToast, type Tone } from "./ui";

interface AdditionalRow {
  id: string;
  harness: HarnessId;
  model: string;
}

interface ExecutionForm {
  workflow: ExecutionMode;
  harness: HarnessId;
  model: string;
  skillPath: string;
  additional: AdditionalRow[];
}

const modes = [...executionModes];
const harnesses: HarnessId[] = ["claude", "codex", "pi"];
const MAX_ADDITIONAL = 8;

const modeHelp: Record<ExecutionMode, string> = {
  separated:
    "Additional reviewers run first, then Main reviews, verifies their evidence and writes one editable draft.",
  docker:
    "Runs your skill and its native tools in a disposable container with a copy of the PR. Set up Docker below guides you through anything it needs.",
  dangerous:
    "Runs the host harness with no app restrictions: it can write files anywhere and publish directly, bypassing the app preview. Every save needs a fresh confirmation.",
};

const modeDetail: Record<ExecutionMode, string> = {
  separated:
    "Main alone still reviews. Every role runs your selected review entry with restricted native tools in a disposable home. This is not OS or process containment, and local stdio MCP never runs on this host.",
  docker:
    "The container gets a writable copy of the PR and immutable pinned source, with no host fallback. Setup asks you to approve the exact code and model tokens the container gets, then separately to confirm its host effects.",
  dangerous:
    "Native tools, plugins, configuration and credentials run unrestricted on this Mac. Connection checkboxes do not constrain it and cancellation does not guarantee detached native processes stop.",
};

const provenanceTone: Record<IsolatedCapabilityPolicy["provenance"][number]["state"], Tone> = {
  inherited: "ok",
  overridden: "info",
  missing: "warn",
  unsupported: "warn",
};

const errorText = (e: unknown) =>
  e instanceof RequestError ? `${e.message}${e.code ? ` (${e.code})` : ""}` : String(e);

const validSkillPath = (path: string) => path.startsWith("/") && /\.md$/i.test(path);
const validModelText = (model: string) => validModel(model || null);

const nextRowId = (rows: AdditionalRow[]) => {
  let n = rows.length + 1;
  while (rows.some((row) => row.id === `reviewer-${n}`)) n += 1;
  return `reviewer-${n}`;
};

const savedForm = (status: HarnessStatus): ExecutionForm => {
  const { selection } = status;
  if (!selection)
    return {
      workflow: "separated",
      harness: "claude",
      model: status.reviewer.model ?? "",
      skillPath: status.reviewer.skillPath,
      additional: [],
    };
  return {
    workflow: selection.workflow,
    harness: selection.harness,
    model: selection.reviewer.model ?? "",
    skillPath: selection.reviewer.skillPath,
    additional:
      selection.version === 3
        ? selection.additional.map((entry) => ({ ...entry, model: entry.model ?? "" }))
        : [],
  };
};

const sameRows = (a: AdditionalRow[], b: AdditionalRow[]) =>
  a.length === b.length &&
  a.every(
    (row, i) =>
      row.id === b[i]!.id &&
      row.harness === b[i]!.harness &&
      row.model.trim() === b[i]!.model.trim(),
  );

const sameForm = (a: ExecutionForm, b: ExecutionForm) =>
  a.workflow === b.workflow &&
  a.harness === b.harness &&
  a.model.trim() === b.model.trim() &&
  a.skillPath.trim() === b.skillPath.trim() &&
  (a.workflow !== "separated" || sameRows(a.additional, b.additional));

const modelText = (model: string | null) => model ?? "native default";

function describeSaved(status: HarnessStatus) {
  const { selection, archivedSelection } = status;
  if (selection?.version === 3) {
    const count = selection.additional.length;
    return `${modeLabel.separated} · Main ${harnessLabel[selection.harness]} (${modelText(
      selection.reviewer.model,
    )})${count ? ` + ${count} Additional` : ", no Additional reviewers"}`;
  }
  if (selection)
    return `${modeLabel[selection.workflow]} · ${harnessLabel[selection.harness]} (${modelText(
      selection.reviewer.model,
    )})`;
  if (archivedSelection)
    return `Archived choice: ${archivedSelection.workflow}${
      archivedSelection.version !== undefined ? ` v${archivedSelection.version}` : ""
    } · ${harnessLabel[archivedSelection.harness]}`;
  return "Nothing saved yet";
}

function Capability({ id, policy }: { id: string; policy: IsolatedCapabilityPolicy }) {
  const loading =
    policy.library.loading === "native-pi"
      ? "Pi native frozen skill loading"
      : "Static read catalog: names, descriptions and files are readable, but native slash/Skill activation, interpolation, hooks and forked subagents do not run";
  const preferences = Object.entries(policy.preferences);
  return (
    <details className="capability" data-testid={`capability-${id}`}>
      <summary className="small">
        <strong>{id === "main" ? "Main" : id}</strong> · {harnessLabel[policy.harness]} ·{" "}
        <span className="mono">{policy.profile}</span>
      </summary>
      <dl className="kv small" style={{ marginTop: 6 }}>
        <dt>Config source</dt>
        <dd>
          <span className="mono">{policy.configSource}</span>{" "}
          <span className="faint">digest {policy.configDigest.slice(0, 12)}</span>
        </dd>
        <dt>Model auth</dt>
        <dd>
          <span className="mono">{policy.auth.kind}</span> from{" "}
          <span className="mono">{policy.auth.source}</span>
          <span className="faint">
            {" "}
            · reference only; presence is not successful authentication and nothing is logged in or
            refreshed here
          </span>
        </dd>
        {preferences.length > 0 && (
          <>
            <dt>Preferences</dt>
            <dd>
              {preferences.map(([key, value]) => (
                <span key={key} className="mono" style={{ marginRight: 8 }}>
                  {key}={String(value)}
                </span>
              ))}
            </dd>
          </>
        )}
        <dt>Library</dt>
        <dd>
          <div>{loading}.</div>
          {policy.library.roots.length > 0 ? (
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {policy.library.roots.map((root) => (
                <li key={root} className="mono">
                  {root}
                </li>
              ))}
            </ul>
          ) : (
            <div className="faint">No trusted native skill roots.</div>
          )}
          {policy.library.skills.length > 0 ? (
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }} aria-label={`${id} native skills`}>
              {policy.library.skills.map((skill) => (
                <li key={skill.path}>
                  <span className="mono">{skill.directory}</span>{" "}
                  <span className="faint mono">{skill.path}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="faint">
              No trusted native skills captured beyond the selected entry.
            </div>
          )}
          {policy.library.diagnostics.map((item) => (
            <div key={item} style={{ color: "var(--warn)" }}>
              {item}
            </div>
          ))}
        </dd>
        <dt>Provenance</dt>
        <dd>
          <ul className="provenance" aria-label={`${id} configuration provenance`}>
            {policy.provenance.map((item) => (
              <li key={`${item.capability}-${item.state}`}>
                <Pill plain tone={provenanceTone[item.state]}>
                  {item.state}
                </Pill>{" "}
                <span className="mono">{item.capability}</span>{" "}
                <span className="faint">
                  {item.message} ({item.evidence.replaceAll("_", " ")})
                </span>
              </li>
            ))}
          </ul>
        </dd>
      </dl>
    </details>
  );
}

export function WorkflowSettings({
  onModeChange,
}: {
  onModeChange: (mode: ExecutionMode | null) => void;
}) {
  const { detailVersion } = useApp();
  const toast = useToast();
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExecutionForm | null>(null);
  const [busy, setBusy] = useState<"save" | "inspect" | "setup" | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"dangerous" | null>(null);
  const [saveCount, setSaveCount] = useState(0);
  const [discoveries, setDiscoveries] = useState<Partial<Record<HarnessId, ModelDiscoveryState>>>(
    {},
  );
  const discoverySeq = useRef<Partial<Record<HarnessId, number>>>({});

  const discover = async (harness: HarnessId) => {
    const seq = (discoverySeq.current[harness] ?? 0) + 1;
    discoverySeq.current[harness] = seq;
    setDiscoveries((all) => ({
      ...all,
      [harness]: {
        loading: true,
        result: all[harness]?.result ?? null,
        error: null,
        failedAt: null,
      },
    }));
    try {
      const result = await api.discoverModels({ harness });
      if (discoverySeq.current[harness] !== seq) return;
      setDiscoveries((all) => ({
        ...all,
        [harness]: { loading: false, result, error: null, failedAt: null },
      }));
    } catch (e) {
      if (discoverySeq.current[harness] !== seq) return;
      setDiscoveries((all) => ({
        ...all,
        [harness]: {
          loading: false,
          result: all[harness]?.result ?? null,
          error: errorText(e),
          failedAt: new Date().toISOString(),
        },
      }));
    }
  };

  const load = useCallback(async () => {
    try {
      setStatus(await api.harness());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, detailVersion["*"]]);

  const selectedMode = status
    ? (draft ?? savedForm(status)).workflow
    : loadError
      ? null
      : undefined;
  useEffect(() => {
    if (selectedMode !== undefined) onModeChange(selectedMode);
  }, [selectedMode, onModeChange]);

  if (loadError && !status)
    return (
      <section className="card" aria-labelledby="workflow-h">
        <div className="card-head">
          <h2 id="workflow-h">Execution</h2>
        </div>
        <div className="card-body">
          <Notice
            tone="danger"
            title="Execution settings are unavailable."
            actions={
              <button type="button" className="button small" onClick={() => void load()}>
                Retry
              </button>
            }
          >
            {loadError}
          </Notice>
        </div>
      </section>
    );
  if (!status)
    return (
      <section className="card" aria-labelledby="workflow-h">
        <div className="card-head">
          <h2 id="workflow-h">Execution</h2>
        </div>
        <div className="card-body">
          <Spinner label="Loading execution settings" />
        </div>
      </section>
    );

  const saved = savedForm(status);
  const current = draft ?? saved;
  const dirty = draft !== null && !sameForm(draft, saved);
  const pathValid = validSkillPath(current.skillPath.trim());
  const rowsValid =
    validModelText(current.model.trim()) &&
    (current.workflow !== "separated" ||
      current.additional.every((row) => validModelText(row.model.trim())));
  const valid = pathValid && rowsValid;
  const canSave = (dirty || status.requiresSave) && valid && busy === null;
  const recapturable = status.selection !== null && !dirty && !status.requiresSave;
  const savedDocker = status.selection?.version === 2 && status.selection.workflow === "docker";
  const showSetup = current.workflow === "docker" || savedDocker;

  const update = (patch: Partial<ExecutionForm>) => setDraft({ ...current, ...patch });
  const updateRow = (id: string, patch: Partial<AdditionalRow>) =>
    update({
      additional: current.additional.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    });

  const body = (): HarnessSelectionUpdate => {
    const reviewer = { skillPath: current.skillPath.trim(), model: current.model.trim() || null };
    if (current.workflow === "separated")
      return {
        version: 3,
        workflow: "separated",
        harness: current.harness,
        reviewer,
        additional: current.additional.map((row) => ({
          id: row.id,
          harness: row.harness,
          model: row.model.trim() || null,
        })),
      };
    return { version: 2, harness: current.harness, workflow: current.workflow, reviewer };
  };

  const save = async (confirmation?: string): Promise<HarnessStatus | null> => {
    setConfirm(null);
    setBusy("save");
    setError(null);
    try {
      const next = await api.selectHarness({
        ...body(),
        ...(confirmation ? { confirmation } : {}),
      });
      setStatus(next);
      setDraft(null);
      setSaveCount((count) => count + 1);
      toast(
        next.effective
          ? `${modeLabel[current.workflow]} ${dirty ? "saved" : "re-saved with recaptured files"} for new sessions`
          : "Saved, but this choice cannot run yet; see the diagnostic",
        next.effective ? "ok" : "warn",
      );
      return next;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const requestSave = () => {
    if (current.workflow === "dangerous") setConfirm("dangerous");
    else void save();
  };

  const currentHarness = harnessLabel[current.harness];
  const isolated = current.workflow === "separated";

  return (
    <section className="card" aria-labelledby="workflow-h">
      <div className="card-head">
        <div>
          <h2 id="workflow-h">Execution</h2>
          <div className="small faint">
            How new reviews, revisions and Ask AI sessions run. Running jobs keep their captured
            settings.
          </div>
        </div>
        <Pill tone={status.evidence === "synthetic_preflight" ? "info" : "neutral"}>
          {status.evidence === "synthetic_preflight" ? "synthetic preflight passed" : "unverified"}
        </Pill>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {error && <Notice tone="danger">{error}</Notice>}
        {loadError && <Notice tone="warn">Showing the last loaded status. {loadError}</Notice>}
        <dl className="kv status" aria-label="Execution status">
          <dt>Saved</dt>
          <dd>{describeSaved(status)}</dd>
          <dt>Can run</dt>
          <dd>
            {status.effective ? (
              <>
                <Pill tone={status.effective.workflow === "dangerous" ? "danger" : "ok"}>
                  {modeLabel[status.effective.workflow]}
                </Pill>{" "}
                <span className="small faint">{status.diagnostics[0]}</span>
              </>
            ) : (
              <>
                <Pill tone="danger">unavailable</Pill>{" "}
                <span className="small">{status.diagnostics[0]}</span>
              </>
            )}
          </dd>
        </dl>
        {status.archivedSelection ? (
          <Notice tone="warn" title="Archived choice cannot run.">
            Save a current choice below to run new reviews. The archived choice is kept for history
            and never upgraded automatically.
          </Notice>
        ) : (
          status.requiresSave && (
            <Notice tone="neutral" title="Not saved yet.">
              Save captures the review entry and each role's settings. Nothing is captured on load.
            </Notice>
          )
        )}
        <div className="field">
          <span className="field-label">Execution type</span>
          <Segmented
            label="Execution type"
            value={current.workflow}
            disabled={busy !== null}
            options={modes.map((value) => ({ value, label: modeLabel[value] }))}
            onChange={(workflow) => update({ workflow })}
          />
          <span className="small faint">{modeHelp[current.workflow]}</span>
          <More label={`More about ${modeLabel[current.workflow]}`}>
            {modeDetail[current.workflow]}
          </More>
        </div>
        <div className="field">
          <span className="field-label">{isolated ? "Main harness" : "Harness"}</span>
          <Segmented
            label={isolated ? "Main harness" : "Harness"}
            value={current.harness}
            disabled={busy !== null}
            options={status.options.map((o) => ({ value: o.id, label: harnessLabel[o.id] }))}
            onChange={(harness) => update({ harness })}
          />
          <span className="small faint">
            {isolated ? "Main writes the draft. " : ""}Uses its existing native login at run time;
            nothing is checked or logged in here.
          </span>
        </div>
        <div className="field">
          <label htmlFor="primary-model">{isolated ? "Main model" : "Model"}</label>
          <ModelSelect
            id="primary-model"
            ariaLabel={isolated ? "Main model" : "Model"}
            harness={current.harness}
            value={current.model}
            placeholder={`native default for ${currentHarness}, resolved on save`}
            disabled={busy !== null}
            discovery={discoveries[current.harness]}
            onDiscover={() => void discover(current.harness)}
            onChange={(model) => update({ model })}
          />
          <More label="About model choices">
            Leave the model empty to resolve and freeze {currentHarness}'s native default when you
            save; the resolved id is shown after saving. Discovery keeps configured/saved IDs
            separate from catalog entries. Claude/Codex start credential-free metadata processes in
            disposable homes; Pi reads static files. No model runs. Choices are not proof of account
            access, mode compatibility or readiness; any valid custom id can still be saved.
            Selected models and the restricted profile take precedence over inherited preferences.
          </More>
        </div>
        {isolated && (
          <div className="field" data-testid="additional-reviewers">
            <span className="field-label">Additional reviewers</span>
            {current.additional.length === 0 && (
              <span className="small faint">
                None. Main alone performs the full review. Add reviewers to run other harnesses or
                models first.
              </span>
            )}
            {current.additional.map((row, index) => (
              <div className="row additional-row" key={row.id} data-testid={`additional-${row.id}`}>
                <span className="small faint mono" style={{ minWidth: 88 }}>
                  {row.id}
                </span>
                <select
                  className="select"
                  aria-label={`Additional reviewer ${index + 1} harness`}
                  value={row.harness}
                  disabled={busy !== null}
                  onChange={(e) => updateRow(row.id, { harness: e.target.value as HarnessId })}
                >
                  {harnesses.map((harness) => (
                    <option key={harness} value={harness}>
                      {harnessLabel[harness]}
                    </option>
                  ))}
                </select>
                <div className="grow">
                  <ModelSelect
                    id={`additional-${row.id}-model`}
                    ariaLabel={`Additional reviewer ${index + 1} model`}
                    harness={row.harness}
                    value={row.model}
                    placeholder={`native default for ${harnessLabel[row.harness]}`}
                    disabled={busy !== null}
                    discovery={discoveries[row.harness]}
                    onDiscover={() => void discover(row.harness)}
                    onChange={(model) => updateRow(row.id, { model })}
                  />
                </div>
                <button
                  type="button"
                  className="button small ghost"
                  aria-label={`Remove additional reviewer ${index + 1}`}
                  disabled={busy !== null}
                  onClick={() =>
                    update({ additional: current.additional.filter((r) => r.id !== row.id) })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="button small"
                disabled={busy !== null || current.additional.length >= MAX_ADDITIONAL}
                onClick={() =>
                  update({
                    additional: [
                      ...current.additional,
                      { id: nextRowId(current.additional), harness: "codex", model: "" },
                    ],
                  })
                }
              >
                Add additional reviewer
              </button>{" "}
              <span className="small faint">
                Up to {MAX_ADDITIONAL}, run in this order before Main.
              </span>
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="skill-path">Review entry path</label>
          <input
            id="skill-path"
            className="input mono"
            value={current.skillPath}
            placeholder="/absolute/path/to/your-review-skill/SKILL.md"
            disabled={busy !== null}
            aria-invalid={!pathValid}
            aria-describedby="skill-path-help"
            onChange={(e) => update({ skillPath: e.target.value })}
          />
          <span id="skill-path-help" className="small faint">
            {pathValid
              ? "Absolute path to your review skill's Markdown entry, shared by every role."
              : "Enter an absolute path to a Markdown entry file, for example /Users/you/.claude/skills/pr-review/SKILL.md."}
          </span>
          <More label="About the review entry">
            Any file name works. Save freezes its bytes and UTF-8 companion directory for new
            sessions; after changing files at the same path, use Re-save unchanged. It must produce
            the documented review output (docs/review-output.md).
          </More>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button
            type="button"
            className="button primary small"
            disabled={!canSave}
            onClick={requestSave}
          >
            {busy === "save"
              ? "Saving..."
              : current.workflow === "dangerous"
                ? "Save Dangerous..."
                : "Save execution"}
          </button>
          {recapturable && (
            <button
              type="button"
              className="button small"
              disabled={!valid || busy !== null}
              onClick={requestSave}
              data-testid="recapture"
            >
              {busy === "save"
                ? "Saving..."
                : current.workflow === "dangerous"
                  ? "Re-save Dangerous unchanged..."
                  : "Re-save unchanged to recapture"}
            </button>
          )}
          {draft && (
            <button
              type="button"
              className="button small ghost"
              disabled={busy !== null}
              onClick={() => setDraft(null)}
            >
              Discard changes
            </button>
          )}
          <span className="small faint">
            Save reads files once
            {recapturable
              ? "; Re-save unchanged captures changed files at the same paths, and nothing is re-read on load or refresh"
              : ""}
            . It never runs a review, logs in, calls a provider or changes automation.
          </span>
        </div>
        {status.selection?.version === 3 && status.capabilities.length > 0 && (
          <div className="stack" style={{ gap: 6 }} data-testid="capabilities">
            <strong className="small">Captured native capabilities</strong>
            <More label="What Save captured">
              Selected review entry <span className="mono">{status.reviewer.skillPath}</span>,
              shared by every role and kept separate from each harness's trusted native library.
              Executable plugins, hooks and extensions found in native configuration are disabled
              for these runs; leave them installed. Each role gets a disposable home with only its
              own harness's model auth reference and a minimum environment; connection credentials
              stay on the app side. These are save-time local observations, not authentication or
              connection success, and not OS or process containment.
            </More>
            {status.capabilities.map((item) => (
              <Capability key={item.id} id={item.id} policy={item.policy} />
            ))}
          </div>
        )}
        {showSetup && (
          <DockerRuntime
            status={status}
            dirty={dirty}
            form={{
              harness: current.harness,
              model: current.model,
              skillPath: current.skillPath,
              problem:
                current.workflow !== "docker"
                  ? "Choose Docker as the execution type to set it up."
                  : !pathValid
                    ? "Enter an absolute path to a Markdown review entry."
                    : !rowsValid
                      ? "Enter a valid model id or leave it empty."
                      : null,
            }}
            busy={busy}
            setBusy={setBusy}
            onSave={save}
            onStatus={setStatus}
            reload={load}
            saveCount={saveCount}
          />
        )}
      </div>
      {confirm === "dangerous" && (
        <Modal
          title={`Confirm Dangerous host execution with ${currentHarness}`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button danger solid"
                onClick={() => void save(dangerousConfirmation)}
              >
                I understand, save Dangerous
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>
              New sessions will start the host <strong>{currentHarness}</strong> with its full
              native tools, plugins, configuration and logins, unrestricted by this app.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>It can write files anywhere on this Mac.</li>
              <li>
                It can publish reviews, comments or commits directly with its own credentials,
                outside the app's exact-payload preview.
              </li>
              <li>Connection checkboxes below do not constrain it.</li>
              <li>Cancellation does not guarantee detached native processes stop.</li>
            </ul>
            <p className="small faint" style={{ margin: 0 }}>
              Confirming saves this choice with consent for {currentHarness} only. Nothing runs now.
              Cancel sends nothing.
            </p>
          </div>
        </Modal>
      )}
    </section>
  );
}
