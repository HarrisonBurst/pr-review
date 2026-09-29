import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  dockerApprovalConfirmation,
  dockerSetupConfirmation,
  type DockerBoundarySnapshot,
  type DockerCapabilityApproval,
  type DockerCapabilityDisclosure,
  type DockerExclusion,
  type DockerInspectRequest,
  type DockerLibraryLeaf,
  type DockerLocalMcpRequest,
  type DockerSourceHandling,
  type DockerSetupStatus,
  type ExecutionStatus,
  type HarnessId,
  type HarnessStatus,
} from "../../../shared/contracts";
import { api, RequestError } from "../api/client";
import { useApp } from "../app-context";
import { harnessLabel } from "../lib/execution";
import { Modal, Notice, Pill, Spinner, useToast, type Tone } from "./ui";

const MAX_LOCAL = 8;
const scopeId = /^[A-Za-z0-9_-]{1,100}$/;

const setupTone: Record<DockerSetupStatus["status"], Tone> = {
  not_started: "neutral",
  running: "accent",
  ready: "ok",
  failed: "danger",
};

const setupLabel: Record<DockerSetupStatus["status"], string> = {
  not_started: "not set up",
  running: "running",
  ready: "ready",
  failed: "failed",
};

const presenceTone: Record<DockerCapabilityDisclosure["authentication"][number]["presence"], Tone> =
  { present: "info", missing: "warn", not_checked: "neutral" };

const kindLabel: Record<DockerCapabilityDisclosure["customizations"][number]["kind"], string> = {
  hooks: "hooks",
  extensions: "extension",
  "skill-code": "skill code",
  "shell-prefix": "shell prefix",
};

const exclusionLabel: Record<DockerExclusion["kind"], string> = {
  "herdr-session-start": "Herdr SessionStart hook",
  "status-line": "status line command",
  "slack-plugin": "Slack plugin activation",
  "google-workspace-skill": "Google Workspace skill",
};

const handlingLabel: Record<DockerSourceHandling["kind"], string> = {
  "finder-metadata": "Finder metadata",
  presentation: "presentation",
  "host-project-trust": "host project trust",
  "library-layout": "library layout",
};

const MAX_EXCLUSIONS = 32;
const MAX_LEAVES = 8;

const errorText = (e: unknown) =>
  e instanceof RequestError ? `${e.message}${e.code ? ` (${e.code})` : ""}` : String(e);

interface LocalChoice {
  included: boolean;
  profileId: string;
  scopeText: string;
  enabled: boolean;
  allowedTools: string[];
}

const short = (digest: string) => digest.slice(0, 12);

const scopeOf = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

function ExclusionDetails({ item }: { item: DockerExclusion }) {
  return (
    <>
      <Pill plain tone="info">
        {exclusionLabel[item.kind]}
      </Pill>{" "}
      <span className="mono">{item.pointer}</span> in <span className="mono">{item.source}</span>{" "}
      <span className="small faint">
        source {short(item.sourceDigest)} · item {short(item.itemDigest)} · id {short(item.id)}
      </span>
      <pre className="mono small" style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>
        {item.definition}
      </pre>
      <div className="small faint">
        {item.rationale} {item.effect} Native settings unchanged:{" "}
        {String(item.nativeSettingsUnchanged)}.
      </div>
    </>
  );
}

function LeafDetails({ leaf }: { leaf: DockerLibraryLeaf }) {
  return (
    <>
      Logical <span className="mono">{leaf.source}</span>
      {leaf.resolvedSourcePath !== leaf.source && (
        <>
          {" "}
          → terminal <span className="mono">{leaf.resolvedSourcePath}</span>
        </>
      )}{" "}
      <span className="small faint">
        ordered-link identity {short(leaf.sourceDigest)} · id {short(leaf.id)}
      </span>
      <div className="small faint">
        Limits: {leaf.limits.entries} entries, {leaf.limits.decodedBytes.toLocaleString()} decoded
        bytes, {leaf.limits.encoding} only. {leaf.effect} Native settings unchanged:{" "}
        {String(leaf.nativeSettingsUnchanged)}.
      </div>
    </>
  );
}

function Disclosure({ disclosure }: { disclosure: DockerCapabilityDisclosure }) {
  const harness = harnessLabel[disclosure.harness];
  return (
    <div className="evidence" data-testid="docker-disclosure">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Pill tone="info">{disclosure.profile}</Pill>
        <Pill plain>{disclosure.evidence.replaceAll("_", " ")}</Pill>
        <span className="small faint">
          disclosure digest <span className="mono">{disclosure.digest}</span>
        </span>
      </div>
      <dl className="kv small" style={{ marginTop: 4 }}>
        <dt>Skill</dt>
        <dd>
          {harness} · <span className="mono">{disclosure.model}</span> ·{" "}
          <span className="mono">{disclosure.skillPath}</span>{" "}
          <span className="faint">digest {short(disclosure.skillDigest)}</span>
        </dd>
        <dt>Resources</dt>
        <dd>
          <details>
            <summary>
              {disclosure.resources.length} portable file
              {disclosure.resources.length === 1 ? "" : "s"} frozen at setup (no contents shown)
            </summary>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }} aria-label="Docker resources">
              {disclosure.resources.map((item) => (
                <li key={item.target}>
                  <span className="mono">{item.source}</span> →{" "}
                  <span className="mono">{item.target}</span>{" "}
                  <span className="faint">digest {short(item.digest)}</span>
                  {item.encoding === "base64" && (
                    <>
                      {" "}
                      <Pill plain tone="neutral">
                        opaque {item.mediaType} data
                      </Pill>{" "}
                      <span className="faint">
                        {item.bytes?.toLocaleString()} decoded bytes, exact-byte encoding, mode{" "}
                        {item.executable ? "executable" : "regular"}; not instructions, not rendered
                        or decoded here, no executable grant
                      </span>
                    </>
                  )}
                  {item.inputDigest && (
                    <span className="faint"> · input digest {short(item.inputDigest)}</span>
                  )}
                  {item.resolvedSourcePath && (
                    <div className="faint">
                      Resolved source <span className="mono">{item.resolvedSourcePath}</span>;
                      source identity <span className="mono">{item.sourceDigest}</span>
                    </div>
                  )}
                  {item.executable && (
                    <>
                      {" "}
                      <Pill plain tone="warn">
                        executable
                      </Pill>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </dd>
        <dt>Source handling</dt>
        <dd>
          {!disclosure.sourceHandling?.length ? (
            <span className="faint">No non-runtime source handling disclosed.</span>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }} aria-label="Docker source handling">
              {disclosure.sourceHandling.map((item) => (
                <li key={`${item.kind}:${item.source}`}>
                  <Pill plain tone="neutral">
                    {handlingLabel[item.kind]}
                  </Pill>{" "}
                  <span className="mono">{item.source}</span>{" "}
                  <span className="faint">digest {short(item.digest)}</span>
                  <div className="faint">{item.effect} Native settings unchanged.</div>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Source-bound exclusions</dt>
        <dd>
          {!disclosure.exclusions?.length ? (
            <span className="faint">
              None selected; every native hook and status line stays as disclosed. No Slack or
              plugin exclusion exists.
            </span>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }} aria-label="Docker source-bound exclusions">
              {disclosure.exclusions.map((item) => (
                <li key={item.id} data-testid={`exclusion-${item.id}`}>
                  <ExclusionDetails item={item} />
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Installed leaves</dt>
        <dd>
          {!disclosure.libraryLeaves?.length ? (
            <span className="faint">No installed skill leaf read was selected.</span>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }} aria-label="Docker installed leaves">
              {disclosure.libraryLeaves.map((leaf) => (
                <li key={leaf.id} data-testid={`leaf-${leaf.id}`}>
                  <LeafDetails leaf={leaf} />
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Customizations</dt>
        <dd>
          {disclosure.customizations.length === 0 ? (
            <span className="faint">
              No executable hooks, extensions, skill code or shell prefix were found in the selected
              configuration.
            </span>
          ) : (
            <ul
              style={{ margin: 0, paddingLeft: 18 }}
              aria-label="Docker executable customizations"
            >
              {disclosure.customizations.map((item) => (
                <li key={item.id} data-testid={`customization-${item.id}`}>
                  <Pill plain tone="warn">
                    {kindLabel[item.kind]}
                  </Pill>{" "}
                  {harnessLabel[item.harness]} · <span className="mono">{item.source}</span>{" "}
                  <span className="faint">
                    digest {short(item.digest)} · id {short(item.id)}
                  </span>
                  <div className="faint">Loaded authority: {item.capabilities.join("; ")}.</div>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Model credentials</dt>
        <dd>
          <ul style={{ margin: 0, paddingLeft: 18 }} aria-label="Docker credential exposures">
            {disclosure.authentication.map((item) => (
              <li key={item.harness} data-testid={`exposure-${item.harness}`}>
                {harnessLabel[item.harness]} own credential from{" "}
                <span className="mono">{item.source}</span>{" "}
                <Pill plain tone={presenceTone[item.presence]}>
                  {item.presence.replaceAll("_", " ")}
                </Pill>{" "}
                <span className="faint">
                  {item.compatibility.replaceAll("_", " ")}, not tested; a{" "}
                  {item.exposure.replaceAll("-", " ")} readable by{" "}
                  {item.readers.replaceAll("-", " ")}, no refresh material. Presence is not
                  validity, expiry or login success.
                </span>
              </li>
            ))}
          </ul>
        </dd>
        <dt>Local stdio tools</dt>
        <dd>
          {disclosure.localConnections.length === 0 ? (
            <span className="faint">None chosen; native MCP configuration is not inherited.</span>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }} aria-label="Docker local stdio tools">
              {disclosure.localConnections.map((item) => (
                <li key={item.request.id} data-testid={`local-${item.request.id}`}>
                  <span className="mono">{item.native.name}</span> from{" "}
                  <span className="mono">{item.native.path}</span> · profile{" "}
                  <span className="mono">{item.profile.id}</span> · scope{" "}
                  <span className="mono">{item.request.scope.join(", ")}</span> ·{" "}
                  {item.request.enabled ? "enabled" : "disabled"}, tools{" "}
                  <span className="mono">{item.request.allowedTools.join(", ") || "none"}</span>{" "}
                  <Pill plain>{item.transport}</Pill>{" "}
                  <Pill plain tone="neutral">
                    inventory {item.inventory.replaceAll("_", " ")}
                  </Pill>{" "}
                  <Pill plain tone="neutral">
                    not connected
                  </Pill>
                  <div className="faint">
                    Frozen entry <span className="mono">{item.target}</span>, source digest{" "}
                    {short(item.sourceDigest)}, profile digest {short(item.profileDigest)}. Runs
                    only inside the container from prepared files; never on this host, never Loaded
                    or Tested here.
                  </div>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Boundary</dt>
        <dd>
          <span className="mono">{disclosure.boundary.source}</span> · network{" "}
          <span className="mono">{disclosure.boundary.network}</span> · source writeback{" "}
          {String(disclosure.boundary.sourceWriteback)} · host execution{" "}
          {String(disclosure.boundary.hostExecution)}
        </dd>
        <dt>Requirements</dt>
        <dd>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {disclosure.requirements.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </dd>
      </dl>
    </div>
  );
}

type FlowStep =
  "save" | "sources" | "check" | "approve" | "confirm" | "running" | "done" | "failed" | "blocked";

const stageOf: Partial<Record<FlowStep, number>> = {
  save: 0,
  sources: 1,
  check: 2,
  approve: 3,
  confirm: 4,
  running: 4,
  done: 5,
};

const stageLabels = ["Save choice", "Source choices", "Check", "Approve", "Set up"];

interface ApprovalItem {
  key: string;
  section: "customizations" | "exposures" | "exclusions" | "leaves" | "locals";
  label: ReactNode;
}

const approvalItems = (disclosure: DockerCapabilityDisclosure): ApprovalItem[] => [
  ...disclosure.customizations.map((item) => ({
    key: `c:${item.id}`,
    section: "customizations" as const,
    label: (
      <>
        {kindLabel[item.kind]} · {harnessLabel[item.harness]} ·{" "}
        <span className="mono">{item.source}</span>{" "}
        <span className="small faint">
          digest {short(item.digest)}; {item.capabilities.join("; ")}
        </span>
      </>
    ),
  })),
  ...disclosure.authentication.map((item) => ({
    key: `a:${JSON.stringify(item)}`,
    section: "exposures" as const,
    label: (
      <>
        {harnessLabel[item.harness]} access token from <span className="mono">{item.source}</span> (
        {item.presence.replaceAll("_", " ")}, not tested), readable by all container code; no
        refresh material.
      </>
    ),
  })),
  ...(disclosure.exclusions ?? []).map((item) => ({
    key: `e:${item.id}`,
    section: "exclusions" as const,
    label: (
      <>
        {exclusionLabel[item.kind]} <span className="mono">{item.pointer}</span> in{" "}
        <span className="mono">{item.source}</span>{" "}
        <span className="small faint">
          item {short(item.itemDigest)}; native settings unchanged
        </span>
      </>
    ),
  })),
  ...(disclosure.libraryLeaves ?? []).map((leaf) => ({
    key: `f:${leaf.id}`,
    section: "leaves" as const,
    label: (
      <>
        <span className="mono">{leaf.source}</span>
        {leaf.resolvedSourcePath !== leaf.source && (
          <>
            {" "}
            → <span className="mono">{leaf.resolvedSourcePath}</span>
          </>
        )}{" "}
        <span className="small faint">
          identity {short(leaf.sourceDigest)}; {leaf.limits.entries} entries,{" "}
          {leaf.limits.decodedBytes.toLocaleString()} bytes, {leaf.limits.encoding}
        </span>
      </>
    ),
  })),
  ...disclosure.localConnections.map((item) => ({
    key: `l:${JSON.stringify([item.request, item.sourceDigest, item.profileDigest, item.target])}`,
    section: "locals" as const,
    label: (
      <>
        <span className="mono">{item.native.name}</span> · profile{" "}
        <span className="mono">{item.profile.id}</span> · scope{" "}
        <span className="mono">{item.request.scope.join(", ")}</span> ·{" "}
        {item.request.enabled ? "enabled" : "disabled"} · tools{" "}
        <span className="mono">{item.request.allowedTools.join(", ") || "none"}</span>
        <span className="small faint"> container stdio only, not tested, not connected</span>
      </>
    ),
  })),
];

const approvedKeys = (boundary: DockerBoundarySnapshot) => {
  const { disclosure, approval } = boundary;
  const approved = new Set([
    ...approval.customizations.map((id) => `c:${id}`),
    ...(approval.exclusions ?? []).map((id) => `e:${id}`),
    ...(approval.libraryLeaves ?? []).map((id) => `f:${id}`),
  ]);
  return new Set(
    approvalItems(disclosure)
      .map((item) => item.key)
      .filter(
        (key) =>
          approved.has(key) ||
          key.startsWith("l:") ||
          (key.startsWith("a:") &&
            approval.credentialExposures.includes(JSON.parse(key.slice(2)).harness)),
      ),
  );
};

const sections: Array<{ id: ApprovalItem["section"]; title: string; aria: string }> = [
  {
    id: "customizations",
    title: "Code that runs inside the container",
    aria: "Approve executable customizations",
  },
  {
    id: "exposures",
    title: "Model access tokens container code can read",
    aria: "Approve credential exposures",
  },
  { id: "exclusions", title: "Left out of Docker only", aria: "Approve source-bound exclusions" },
  { id: "leaves", title: "Installed skills copied in", aria: "Approve installed leaf reads" },
  { id: "locals", title: "Local tools inside the container", aria: "Approve local stdio tools" },
];

const changedSinceSave = (message: string) => /changed since Save/i.test(message);

export interface DockerForm {
  harness: HarnessId;
  model: string;
  skillPath: string;
  problem: string | null;
}

function DockerSetupFlow({
  status,
  form,
  needsSave,
  busy,
  setBusy,
  onSave,
  onStatus,
  reload,
  request,
  requestProblem,
  sources,
  sourcesBusy,
  resetSources,
  sessionApproval,
  onClose,
}: {
  status: HarnessStatus;
  form: DockerForm;
  needsSave: boolean;
  busy: string | null;
  setBusy: (value: "inspect" | "setup" | "check" | null) => void;
  onSave: () => Promise<HarnessStatus | null>;
  onStatus: (status: HarnessStatus) => void;
  reload: () => Promise<void>;
  request: (harness: HarnessId) => DockerInspectRequest;
  requestProblem: string | null;
  sources: ReactNode;
  sourcesBusy: boolean;
  resetSources: () => void;
  sessionApproval: MutableRefObject<DockerBoundarySnapshot | null>;
  onClose: () => void;
}) {
  const toast = useToast();
  const initial: FlowStep =
    status.setup.status === "running" ? "running" : needsSave ? "save" : "sources";
  const [step, setStep] = useState<FlowStep>(initial);
  const [stage, setStage] = useState(stageOf[initial]!);
  const [error, setError] = useState<string | null>(null);
  const [recapture, setRecapture] = useState(false);
  const [preview, setPreview] = useState<{
    disclosure: DockerCapabilityDisclosure;
    harness: HarnessId;
  } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [reused, setReused] = useState<Set<string> | null>(null);
  const [inspectToken, setInspectToken] = useState(0);
  const [approved] = useState(() =>
    api
      .execution()
      .then((execution) => execution.lastApprovedDocker ?? execution.snapshot?.docker ?? null)
      .catch(() => null),
  );
  const handled = useRef(0);
  const posted = useRef(false);
  const live = useRef(true);
  const body = useRef<HTMLDivElement>(null);
  const saved =
    status.selection?.version === 2 && status.selection.workflow === "docker"
      ? status.selection
      : null;
  const harness = harnessLabel[saved?.harness ?? form.harness];

  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const go = (next: FlowStep) => {
    setStep(next);
    if (stageOf[next] !== undefined) setStage(stageOf[next]!);
  };

  const close = useCallback(() => {
    live.current = false;
    onClose();
  }, [onClose]);

  useEffect(() => {
    body.current
      ?.querySelector<HTMLElement>(
        "[data-autofocus], input:not(:disabled), button:not(:disabled), summary",
      )
      ?.focus();
  }, [step]);

  const fail = (message: string) => {
    setError(message);
    go("failed");
  };

  useEffect(() => {
    if (!inspectToken || handled.current === inspectToken || !saved) return;
    handled.current = inspectToken;
    if (requestProblem) {
      go("blocked");
      return;
    }
    const inspectBody = request(saved.harness);
    go("check");
    setError(null);
    setBusy("inspect");
    void (async () => {
      try {
        const [disclosure, cached] = await Promise.all([api.inspectDocker(inspectBody), approved]);
        if (!live.current) return;
        const prior = [sessionApproval.current, cached].find(
          (boundary) => boundary?.disclosure.harness === saved.harness,
        );
        const keys = approvalItems(disclosure).map((item) => item.key);
        const previous = prior ? approvedKeys(prior) : null;
        setPreview({ disclosure, harness: saved.harness });
        setReused(previous);
        setChecked(new Set(keys.filter((key) => previous?.has(key))));
        go("approve");
      } catch (e) {
        if (live.current) fail(errorText(e));
      } finally {
        setBusy(null);
      }
    })();
  }, [inspectToken, saved, requestProblem]);

  useEffect(() => {
    if (step !== "running" || posted.current || status.setup.status === "running") return;
    if (status.effective && status.mode === "docker") go("done");
    else fail(status.setup.status === "failed" ? status.setup.message : status.diagnostics[0]!);
  }, [step, status]);

  const inspectAgain = () => setInspectToken((token) => token + 1);

  const save = async () => {
    setError(null);
    const next = await onSave();
    if (!live.current || !next) return;
    setRecapture(false);
    if (next.effective && next.mode === "docker") go("done");
    else go("sources");
  };

  const disclosure = preview?.disclosure ?? null;
  const items = disclosure ? approvalItems(disclosure) : [];
  const complete = items.every((item) => checked.has(item.key));

  const runSetup = async () => {
    if (!disclosure || !preview || !complete) return;
    const approval: DockerCapabilityApproval = {
      digest: disclosure.digest,
      ...(disclosure.exclusions?.length
        ? { exclusions: disclosure.exclusions.map((item) => item.id) }
        : {}),
      ...(disclosure.libraryLeaves?.length
        ? { libraryLeaves: disclosure.libraryLeaves.map((leaf) => leaf.id) }
        : {}),
      customizations: disclosure.customizations.map((item) => item.id),
      credentialExposures: disclosure.authentication.map((item) => item.harness),
      confirmation: dockerApprovalConfirmation,
    };
    sessionApproval.current = { profile: "container-native-1", disclosure, approval };
    posted.current = true;
    go("running");
    setError(null);
    setBusy("setup");
    try {
      const next = await api.setupDocker({
        harness: preview.harness,
        confirmation: dockerSetupConfirmation,
        approval,
      });
      onStatus(next);
      if (next.effective && next.mode === "docker") {
        toast(`Docker is ready for ${harnessLabel[preview.harness]}`, "ok");
        if (live.current) go("done");
      } else if (live.current) fail(next.diagnostics[0]!);
    } catch (e) {
      if (live.current) fail(errorText(e));
      await reload();
    } finally {
      posted.current = false;
      setBusy(null);
    }
  };

  const retry = () => {
    if (error && changedSinceSave(error)) {
      setRecapture(true);
      go("save");
    } else {
      resetSources();
      go("sources");
    }
  };

  const toggle = (key: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(key);
    else next.delete(key);
    setChecked(next);
  };

  const content = (): ReactNode => {
    switch (step) {
      case "save":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }} tabIndex={-1} data-autofocus>
              {recapture
                ? "Your review entry's files changed since you saved. Save again to capture them, then setup continues."
                : "First, save Docker as your execution choice. New reviews stay unavailable until setup finishes."}
            </p>
            <dl className="kv small">
              <dt>Harness</dt>
              <dd>{harnessLabel[form.harness]}</dd>
              <dt>Model</dt>
              <dd className="mono">{form.model.trim() || "native default, resolved on save"}</dd>
              <dt>Review entry</dt>
              <dd className="mono">{form.skillPath.trim()}</dd>
            </dl>
            {form.problem ? (
              <Notice tone="warn">{form.problem} Fix it in the form, then set up again.</Notice>
            ) : (
              <div className="row wrap">
                <button
                  type="button"
                  className="button small primary"
                  disabled={busy !== null}
                  onClick={() => void save()}
                >
                  {busy === "save" ? "Saving..." : "Save and continue"}
                </button>
              </div>
            )}
          </div>
        );
      case "sources":
        return (
          <div className="stack" style={{ gap: 10 }}>
            <p style={{ margin: 0 }} tabIndex={-1} data-autofocus>
              Choose any bounded installed skill reads and Docker-only exclusions before checking.
              Optional external skill leaves are omitted unless you explicitly select their reads,
              separately for each logical alias. No new leaf is selected from an earlier setup
              approval.
            </p>
            {error && (
              <Notice tone="warn" title="Last check refused.">
                {error}
              </Notice>
            )}
            {sources}
            <button
              type="button"
              className="button small primary"
              disabled={busy !== null || sourcesBusy}
              onClick={inspectAgain}
            >
              Inspect with these choices
            </button>
          </div>
        );
      case "check":
        return (
          <p style={{ margin: 0 }} tabIndex={-1} data-autofocus aria-live="polite">
            Checking what Docker would run for {harness}. This reads your saved files only; nothing
            runs or is approved.
          </p>
        );
      case "blocked":
        return <Notice tone="warn">{requestProblem}</Notice>;
      case "approve":
        return (
          <div className="stack" style={{ gap: 10 }}>
            <p style={{ margin: 0 }} tabIndex={-1} data-autofocus>
              Approve exactly what Docker runs with {harness}.{" "}
              {reused?.size
                ? "Items you approved before and that haven't changed are already checked; check anything new or changed."
                : "Nothing is pre-approved; check each item."}{" "}
              To change optional source choices, cancel and return to Source choices. Native files
              stay unchanged.
            </p>
            {sections.map((section) => {
              const rows = items.filter((item) => item.section === section.id);
              if (!rows.length) return null;
              return (
                <fieldset
                  className="stack"
                  style={{ gap: 4 }}
                  key={section.id}
                  aria-label={section.aria}
                >
                  <legend className="small">
                    <strong>{section.title}</strong>
                  </legend>
                  {rows.map((item) => (
                    <label className="check-row" key={item.key}>
                      <input
                        type="checkbox"
                        checked={checked.has(item.key)}
                        onChange={(event) => toggle(item.key, event.target.checked)}
                      />
                      <span>
                        {item.label}{" "}
                        {reused &&
                          (reused.has(item.key) ? (
                            <Pill plain tone="ok">
                              approved before, unchanged
                            </Pill>
                          ) : (
                            <Pill plain tone="warn">
                              new or changed
                            </Pill>
                          ))}
                      </span>
                    </label>
                  ))}
                </fieldset>
              );
            })}
            <details className="disclosure">
              <summary>Technical details</summary>
              <Disclosure disclosure={disclosure!} />
            </details>
            <div className="row wrap">
              <button
                type="button"
                className="button small primary"
                disabled={!complete}
                onClick={() => go("confirm")}
              >
                Approve and continue
              </button>
            </div>
          </div>
        );
      case "confirm":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }} tabIndex={-1} data-autofocus>
              Last step: set up the Docker runtime for {harness} with approval{" "}
              <span className="mono">{short(disclosure!.digest)}</span>. This:
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>Re-reads and revalidates the approved files; any change stops before install.</li>
              <li>
                Downloads publisher-verified pinned Linux packages and the verified Docker image
                when missing, using a credential-free installer container with network access.
              </li>
              <li>Writes only app-owned cache and internal runtime files.</li>
              <li>Runs the credential-free Docker policy and runtime check.</li>
            </ul>
            <p className="small faint" style={{ margin: 0 }}>
              It does not install Docker Desktop, sign in, refresh or read model credentials, call a
              model or provider, change your execution choice or automation.
            </p>
            {status.setup.status === "failed" && (
              <Notice tone="warn" title="Last attempt failed.">
                {status.setup.message}
              </Notice>
            )}
            <div className="row wrap">
              <button
                type="button"
                className="button small primary"
                disabled={busy !== null}
                onClick={() => void runSetup()}
              >
                Set up Docker
              </button>
              <button type="button" className="button small ghost" onClick={() => go("approve")}>
                Back
              </button>
            </div>
          </div>
        );
      case "running":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <Spinner label={`Setting up Docker for ${harness}...`} />
            <p className="small" style={{ margin: 0 }} tabIndex={-1} data-autofocus>
              Revalidating files, preparing the pinned runtime and running the policy check. The
              first setup can take a few minutes.
            </p>
            <p className="small faint" style={{ margin: 0 }}>
              Closing this window doesn't stop setup; the Docker card shows when it finishes.
            </p>
            {!posted.current && (
              <div className="row wrap">
                <button type="button" className="button small" onClick={() => void reload()}>
                  Check status
                </button>
              </div>
            )}
          </div>
        );
      case "done":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }} tabIndex={-1} data-autofocus>
              <Pill tone="ok">Ready</Pill> Docker runs new reviews with {harness}.
            </p>
            <p className="small faint" style={{ margin: 0 }}>
              Ready means the runtime and policy check passed. It doesn't test sign-in, models or
              connections.
            </p>
          </div>
        );
      case "failed":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <Notice tone="danger" title="That step didn't work.">
              {error}
            </Notice>
            <p className="small" style={{ margin: 0 }}>
              Nothing was selected or stripped.{" "}
              {error && changedSinceSave(error)
                ? "Try again saves your changed files first, then asks for fresh source choices."
                : "Try again returns to source choices. Keep optional external skill reads unchecked to omit them, or observe and select each wanted alias before inspecting."}
            </p>
            <div className="row wrap">
              <button
                type="button"
                className="button small primary"
                disabled={busy !== null}
                onClick={retry}
              >
                Try again
              </button>
            </div>
          </div>
        );
    }
  };

  const effectful = step === "running" || step === "done";
  return (
    <Modal
      title={`Set up Docker for ${harness}`}
      onClose={close}
      footer={
        <button type="button" className="button" onClick={close}>
          {step === "done" ? "Done" : effectful ? "Close" : "Cancel"}
        </button>
      }
    >
      <div className="stack" style={{ gap: 12 }} data-testid="docker-flow" ref={body}>
        <ol className="connect-stages" aria-label="Docker setup progress">
          {stageLabels.map((label, index) => (
            <li
              key={label}
              data-state={index < stage ? "done" : index === stage ? "current" : "todo"}
              aria-current={index === stage ? "step" : undefined}
            >
              {label}
            </li>
          ))}
        </ol>
        {content()}
        {!effectful && (
          <p className="small faint" style={{ margin: 0 }}>
            Cancel stops here. Selected source reads happen only on Inspect; container capability
            approval and installation require the later Set up Docker step.
          </p>
        )}
      </div>
    </Modal>
  );
}

interface Readiness {
  tone: Tone;
  label: string;
  detail?: string;
  problem?: string;
  action: "Set up Docker" | "Fix setup" | "View progress" | null;
}

function readiness(status: HarnessStatus, needsSave: boolean): Readiness {
  const { setup } = status;
  const harness = status.selection ? harnessLabel[status.selection.harness] : "";
  if (setup.status === "running")
    return {
      tone: "accent",
      label: "Setting up",
      detail: setup.harness ? `for ${harnessLabel[setup.harness]}` : undefined,
      action: "View progress",
    };
  if (needsSave)
    return {
      tone: "neutral",
      label: "Not saved",
      detail: "Set up saves this choice first",
      action: "Set up Docker",
    };
  if (status.effective && status.mode === "docker")
    return {
      tone: "ok",
      label: "Ready",
      detail: `${harness} · runtime check passed, sign-in not tested`,
      action: null,
    };
  if (setup.status === "failed" && setup.harness === status.selection?.harness)
    return { tone: "danger", label: "Setup failed", problem: setup.message, action: "Fix setup" };
  if (setup.status === "ready")
    return {
      tone: "warn",
      label: "Needs attention",
      problem: status.diagnostics[0],
      action: "Fix setup",
    };
  return {
    tone: "neutral",
    label: "Not set up",
    detail: "One-time setup; you approve what runs in the container",
    action: "Set up Docker",
  };
}

export function DockerRuntime({
  status,
  dirty,
  form,
  busy,
  setBusy,
  onSave,
  onStatus,
  reload,
  saveCount,
}: {
  status: HarnessStatus;
  dirty: boolean;
  form: DockerForm;
  busy: string | null;
  setBusy: (value: "inspect" | "setup" | "check" | null) => void;
  onSave: () => Promise<HarnessStatus | null>;
  onStatus: (status: HarnessStatus) => void;
  reload: () => Promise<void>;
  saveCount: number;
}) {
  const { state } = useApp();
  const toast = useToast();
  const [locals, setLocals] = useState<Record<string, LocalChoice>>({});
  const [preflight, setPreflight] = useState<ExecutionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const sessionApproval = useRef<DockerBoundarySnapshot | null>(null);
  const [exclusionCandidates, setExclusionCandidates] = useState<DockerExclusion[] | null>(null);
  const [selectedExclusions, setSelectedExclusions] = useState<Set<string>>(new Set());
  const [leafCandidates, setLeafCandidates] = useState<DockerLibraryLeaf[]>([]);
  const [selectedLeaves, setSelectedLeaves] = useState<Set<string>>(new Set());
  const [leafSource, setLeafSource] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState<"exclusions" | "leaf" | null>(null);

  const sourceGeneration = useRef(0);
  const resetSources = () => {
    sourceGeneration.current += 1;
    setExclusionCandidates(null);
    setSelectedExclusions(new Set());
    setLeafCandidates([]);
    setSelectedLeaves(new Set());
    setSourceError(null);
    setSourceBusy(null);
  };
  const [clearedAtSave, setClearedAtSave] = useState(saveCount);
  if (clearedAtSave !== saveCount) {
    setClearedAtSave(saveCount);
    setPreflight(null);
    resetSources();
  }

  const catalog = state.integrations;
  const profiles = catalog.profiles ?? [];
  const stdio = catalog.connections.filter((item) => item.config.native?.transport === "stdio");
  const setup = status.setup;
  const saved =
    status.selection?.version === 2 && status.selection.workflow === "docker"
      ? status.selection
      : null;
  const needsSave = !saved || dirty || status.requiresSave;
  const summary = readiness(status, needsSave);
  const included = stdio.filter((item) => locals[item.config.id]?.included);
  const choice = (id: string): LocalChoice =>
    locals[id] ?? {
      included: false,
      profileId: profiles[0]?.id ?? "",
      scopeText: "",
      enabled: false,
      allowedTools: [],
    };
  const scopeValid = (text: string) => {
    const scope = scopeOf(text);
    return scope.length >= 1 && scope.length <= 100 && scope.every((value) => scopeId.test(value));
  };
  const localsValid = included.every(
    (item) => choice(item.config.id).profileId && scopeValid(choice(item.config.id).scopeText),
  );
  const chosenExclusions = (exclusionCandidates ?? [])
    .filter((item) => selectedExclusions.has(item.id))
    .map((item) => item.id);
  const chosenLeaves = leafCandidates
    .filter((leaf) => selectedLeaves.has(leaf.id))
    .map((leaf) => leaf.id);
  const request = (harness: HarnessId): DockerInspectRequest => ({
    harness,
    ...(chosenExclusions.length ? { exclusions: chosenExclusions } : {}),
    ...(chosenLeaves.length ? { libraryLeaves: chosenLeaves } : {}),
    ...(included.length
      ? {
          localConnections: included.map((item): DockerLocalMcpRequest => {
            const value = choice(item.config.id);
            return {
              id: item.config.id,
              profileId: value.profileId,
              scope: scopeOf(value.scopeText),
              enabled: value.enabled,
              allowedTools: value.allowedTools,
            };
          }),
        }
      : {}),
  });
  const requestProblem = localsValid
    ? null
    : "Each included local tool under Advanced needs a known profile and 1-100 exact document ids. Close this, finish or clear those choices, then set up again.";
  const sourcesBlocked = busy !== null || sourceBusy !== null || !saved || dirty;

  const updateLocal = (id: string, patch: Partial<LocalChoice>) =>
    setLocals({ ...locals, [id]: { ...choice(id), ...patch } });

  const discoverExclusions = async () => {
    const generation = sourceGeneration.current;
    setSourceBusy("exclusions");
    setSourceError(null);
    try {
      const result = await api.discoverDockerExclusions();
      if (generation !== sourceGeneration.current) return;
      setExclusionCandidates(result.exclusions);
      setSelectedExclusions(
        new Set([...selectedExclusions].filter((id) => result.exclusions.some((e) => e.id === id))),
      );
      toast("Exclusion candidates discovered; none is selected and native settings are unchanged");
    } catch (e) {
      if (generation === sourceGeneration.current) setSourceError(errorText(e));
    } finally {
      if (generation === sourceGeneration.current) setSourceBusy(null);
    }
  };

  const observeLeaf = async () => {
    const source = leafSource.trim();
    const generation = sourceGeneration.current;
    setSourceBusy("leaf");
    setSourceError(null);
    try {
      const leaf = await api.discoverDockerLibraryLeaf({ source });
      if (generation !== sourceGeneration.current) return;
      setSelectedLeaves(
        (selected) =>
          new Set(
            [...selected].filter(
              (id) => !leafCandidates.some((item) => item.source === leaf.source && item.id === id),
            ),
          ),
      );
      setLeafCandidates((all) => [...all.filter((item) => item.source !== leaf.source), leaf]);
      setLeafSource("");
      toast("Installed leaf metadata observed; no content was read and nothing is selected");
    } catch (e) {
      if (generation === sourceGeneration.current) setSourceError(errorText(e));
    } finally {
      if (generation === sourceGeneration.current) setSourceBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setError(null);
    try {
      setPreflight(await api.checkExecution());
      await reload();
      toast("Synthetic preflight passed; runtime evidence only", "ok");
    } catch (e) {
      setPreflight(null);
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const toggle = <T,>(set: Set<T>, value: T, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };

  const closeFlow = useCallback(() => {
    sourceGeneration.current += 1;
    setSourceBusy(null);
    setOpen(false);
  }, []);

  const sources = (
    <>
      {sourceError && <Notice tone="danger">{sourceError}</Notice>}
      <div className="stack" style={{ gap: 6 }} data-testid="docker-exclusions">
        <strong className="small">Source-bound exclusions</strong>
        <div className="row wrap" style={{ gap: 8, alignItems: "flex-start" }}>
          <button
            type="button"
            className="button small"
            disabled={sourcesBlocked}
            onClick={() => void discoverExclusions()}
            data-testid="docker-discover-exclusions"
          >
            {sourceBusy === "exclusions"
              ? "Discovering..."
              : exclusionCandidates
                ? "Rediscover exclusion candidates"
                : "Discover exclusion candidates"}
          </button>
          <span className="small faint">
            Discover source-bound Herdr, status-line, Slack activation and Google Workspace skill
            exclusions for the saved Docker choice. Reads bounded native settings and synced-library
            metadata, plus the recognized Google skill and sibling manifest to bind exact contents.
            No code runs; selection changes Docker only.
          </span>
        </div>
        {exclusionCandidates?.length === 0 && (
          <span className="small faint">
            No recognized exclusion candidates. Optional external skill leaves still require
            separate read consent below; other skills, hooks and plugins are not excluded here.
            Native files remain unchanged.
          </span>
        )}
        {exclusionCandidates?.map((item) => (
          <label className="check-row" key={item.id} data-testid={`docker-exclusion-${item.id}`}>
            <input
              type="checkbox"
              checked={selectedExclusions.has(item.id)}
              disabled={
                busy !== null ||
                (!selectedExclusions.has(item.id) && selectedExclusions.size >= MAX_EXCLUSIONS)
              }
              onChange={(event) =>
                setSelectedExclusions(toggle(selectedExclusions, item.id, event.target.checked))
              }
            />
            <span>
              Omit from Docker: <ExclusionDetails item={item} />
            </span>
          </label>
        ))}
      </div>
      <div className="stack" style={{ gap: 6 }} data-testid="docker-leaves">
        <strong className="small">Installed skill leaf reads</strong>
        <div className="row wrap" style={{ gap: 8, alignItems: "flex-end" }}>
          <div className="field grow">
            <label htmlFor="docker-leaf-source">Installed skill leaf (absolute path)</label>
            <input
              id="docker-leaf-source"
              className="input mono"
              value={leafSource}
              placeholder="one direct child of a declared native skills root"
              disabled={busy !== null}
              onChange={(event) => setLeafSource(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="button small"
            disabled={
              sourcesBlocked ||
              !leafSource.trim().startsWith("/") ||
              (leafCandidates.length >= MAX_LEAVES &&
                !leafCandidates.some((leaf) => leaf.source === leafSource.trim()))
            }
            onClick={() => void observeLeaf()}
            data-testid="docker-observe-leaf"
          >
            {sourceBusy === "leaf" ? "Observing..." : "Observe installed leaf metadata"}
          </button>
        </div>
        <span className="small faint">
          Metadata only: resolves the exact logical and terminal paths and ordered-link identity of
          one installed skill child and its <span className="mono">SKILL.md</span>, without reading
          contents or companions. Observation grants no read; only the separate choice below selects
          an exact leaf for setup (up to {MAX_LEAVES}). Unselected external leaves are omitted
          without reading their contents. This does not omit the selected review entry or ordinary
          bounded native libraries. Different logical aliases of one terminal are distinct choices.
          Save or restart clears observed candidates.
        </span>
        {leafCandidates.map((leaf) => (
          <label className="check-row" key={leaf.id} data-testid={`docker-leaf-${leaf.id}`}>
            <input
              type="checkbox"
              checked={selectedLeaves.has(leaf.id)}
              disabled={busy !== null}
              onChange={(event) =>
                setSelectedLeaves(toggle(selectedLeaves, leaf.id, event.target.checked))
              }
            />
            <span>
              Read and freeze this installed leaf: <LeafDetails leaf={leaf} />
            </span>
          </label>
        ))}
      </div>
    </>
  );

  return (
    <div className="integration-card stack" style={{ gap: 8 }} data-testid="docker-setup">
      <div className="integration-head">
        <div className="integration-identity">
          <strong>Docker runtime</strong>
          <div className="integration-status" data-testid="docker-status">
            <Pill tone={summary.tone} live={setup.status === "running"}>
              {summary.label}
            </Pill>
            {summary.detail && <span className="small muted">{summary.detail}</span>}
          </div>
        </div>
        {summary.action && (
          <button
            type="button"
            className={`button small${summary.action === "View progress" ? "" : " primary"}`}
            disabled={summary.action !== "View progress" && busy !== null}
            onClick={() => setOpen(true)}
            data-testid="docker-action"
          >
            {summary.action}
          </button>
        )}
      </div>
      {summary.problem && (
        <p className="small connection-problem" data-testid="docker-problem">
          {summary.problem}
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {preflight && (
        <Notice tone="info" title="Preflight result.">
          {preflight.message}
        </Notice>
      )}
      <details className="integration-diagnostics" data-testid="docker-advanced">
        <summary>Advanced</summary>
        <div className="stack" style={{ gap: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <div className="integration-status">
              <Pill plain tone={setupTone[setup.status]}>
                cached setup {setupLabel[setup.status]}
                {setup.harness ? ` for ${harnessLabel[setup.harness]}` : ""}
              </Pill>
            </div>
            <span className="small">{setup.message}</span>
            {!status.effective && !summary.problem && (
              <span className="small faint">{status.diagnostics[0]}</span>
            )}
            <span className="small faint">
              Loading only shows cached status; it never checks, approves or sets up. A cached setup
              for another path, model or approval is not ready for this choice. Ready means the
              runtime and policy check passed, never signed in or Connected. Setup never changes
              your execution choice, installs Docker Desktop, reads auth, calls a model or changes
              automation.
            </span>
          </div>
          {status.effective && status.mode === "docker" && (
            <div className="row wrap" style={{ alignItems: "flex-start" }}>
              <button
                type="button"
                className="button small"
                disabled={busy !== null}
                onClick={() => void check()}
              >
                {busy === "check" ? "Checking..." : "Run credential-free boundary check"}
              </button>
              <button
                type="button"
                className="button small"
                disabled={busy !== null}
                onClick={() => setOpen(true)}
                data-testid="docker-setup-again"
              >
                Set up again
              </button>
              <span className="small faint">
                The check is a runtime preflight, not a model, sign-in or connection test. Set up
                again applies changed local tools, exclusions or installed skills below.
              </span>
            </div>
          )}
          <div className="stack" style={{ gap: 6 }} data-testid="docker-local-tools">
            <strong className="small">Local stdio tools inside the container</strong>
            {stdio.length === 0 ? (
              <span className="small faint">
                No discovered local stdio entries. Discover a Claude JSON or Codex TOML source under
                Connections; only a Node <span className="mono">.mjs</span> entry with prepared
                portable files is locally compatible, and nothing runs on this host.
              </span>
            ) : (
              <span className="small faint">
                Choose which discovered stdio entries the container may run from frozen files (up to{" "}
                {MAX_LOCAL}). Each is disabled with no tool grants until you choose otherwise. Host
                Load/Test never run for stdio. Unsupported entries fail during setup with a
                diagnostic.
              </span>
            )}
            {stdio.map((item) => {
              const id = item.config.id;
              const native = item.config.native!;
              const value = choice(id);
              const profile = profiles.find((entry) => entry.id === value.profileId);
              return (
                <div
                  className="stack"
                  style={{ gap: 4 }}
                  key={id}
                  data-testid={`docker-local-${id}`}
                >
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={value.included}
                      disabled={busy !== null || (!value.included && included.length >= MAX_LOCAL)}
                      onChange={(event) => updateLocal(id, { included: event.target.checked })}
                    />
                    <span>
                      Include <span className="mono">{native.name}</span>{" "}
                      <span className="small faint">
                        {harnessLabel[native.harness]} · <span className="mono">{native.path}</span>{" "}
                        · digest {short(native.digest)} · stdio is unsupported on the Isolated host
                        and for remote evidence; Docker checks local compatibility during setup.
                      </span>
                    </span>
                  </label>
                  {value.included && (
                    <div className="stack" style={{ gap: 4, marginLeft: 22 }}>
                      <div className="row wrap" style={{ gap: 8, alignItems: "flex-end" }}>
                        <div className="field">
                          <label htmlFor={`docker-profile-${id}`}>Known profile</label>
                          <select
                            id={`docker-profile-${id}`}
                            className="select"
                            value={value.profileId}
                            disabled={busy !== null}
                            onChange={(event) =>
                              updateLocal(id, { profileId: event.target.value, allowedTools: [] })
                            }
                          >
                            {profiles.map((entry) => (
                              <option key={entry.id} value={entry.id}>
                                {entry.label} ({entry.id})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field grow">
                          <label htmlFor={`docker-scope-${id}`}>Document ids (1-100)</label>
                          <input
                            id={`docker-scope-${id}`}
                            className="input mono"
                            placeholder="doc-1 doc-2"
                            value={value.scopeText}
                            disabled={busy !== null}
                            aria-invalid={
                              value.scopeText.trim() !== "" && !scopeValid(value.scopeText)
                            }
                            onChange={(event) => updateLocal(id, { scopeText: event.target.value })}
                          />
                        </div>
                      </div>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={value.enabled}
                          disabled={busy !== null}
                          onChange={(event) => updateLocal(id, { enabled: event.target.checked })}
                        />
                        <span>
                          Enabled for container sessions of{" "}
                          <span className="mono">{native.name}</span>
                        </span>
                      </label>
                      {profile && (
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={value.allowedTools.includes(profile.tool.id)}
                            disabled={busy !== null}
                            onChange={(event) =>
                              updateLocal(id, {
                                allowedTools: event.target.checked ? [profile.tool.id] : [],
                              })
                            }
                          />
                          <span>
                            Allow tool <span className="mono">{profile.tool.name}</span> (
                            <span className="mono">{profile.tool.id}</span>) for{" "}
                            <span className="mono">{native.name}</span>
                          </span>
                        </label>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {requestProblem && <span className="small connection-problem">{requestProblem}</span>}
          </div>
          {!open && sources}
        </div>
      </details>
      {open && (
        <DockerSetupFlow
          status={status}
          form={form}
          needsSave={needsSave}
          busy={busy}
          setBusy={setBusy}
          onSave={onSave}
          onStatus={onStatus}
          reload={reload}
          request={request}
          requestProblem={requestProblem}
          sources={sources}
          sourcesBusy={sourceBusy !== null}
          resetSources={resetSources}
          sessionApproval={sessionApproval}
          onClose={closeFlow}
        />
      )}
    </div>
  );
}
