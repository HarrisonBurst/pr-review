import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  validModel,
  type HarnessId,
  type HarnessModelChoice,
  type HarnessModelDiscovery,
} from "../../../shared/contracts";
import { harnessLabel } from "../lib/execution";
import { formatDate } from "../lib/format";
import { Pill, type Tone } from "./ui";

export interface ModelDiscoveryState {
  loading: boolean;
  result: HarnessModelDiscovery | null;
  error: string | null;
  failedAt: string | null;
}

export const NATIVE_DEFAULT_LABEL = "Native default (resolved on Save)";
const MAX_VISIBLE = 200;

type Option =
  | { kind: "default"; value: "" }
  | { kind: "custom"; value: string }
  | { kind: "choice"; value: string; choice: HarnessModelChoice };

const sourceTone: Record<HarnessModelDiscovery["sources"][number]["status"], Tone> = {
  ready: "ok",
  partial: "warn",
  missing: "neutral",
  unsupported: "neutral",
  error: "danger",
};

const isCatalogChoice = (
  choice: HarnessModelChoice,
  result: HarnessModelDiscovery | undefined | null,
) =>
  choice.sources.some((id) =>
    result?.sources.some(
      (source) => source.id === id && ["catalog", "cached_catalog"].includes(source.kind),
    ),
  );

const matches = (choice: HarnessModelChoice, query: string) =>
  query === "" ||
  choice.model.toLowerCase().includes(query) ||
  choice.label.toLowerCase().includes(query);

export function ModelSelect({
  id,
  harness,
  value,
  onChange,
  disabled,
  ariaLabel,
  placeholder,
  discovery,
  onDiscover,
}: {
  id: string;
  harness: HarnessId;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  ariaLabel: string;
  placeholder: string;
  discovery: ModelDiscoveryState | undefined;
  onDiscover: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState<string | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const requested = useRef<HarnessId | null>(null);
  const listId = `${id}-listbox`;
  const statusId = useId();
  const choices = discovery?.result?.models ?? [];
  const trimmed = value.trim();
  const exact = choices.find((choice) => choice.model === trimmed);
  const filter = (query ?? "").trim().toLowerCase();
  const filtered = choices.filter((choice) => matches(choice, filter));
  const options: Option[] = [
    { kind: "default", value: "" },
    ...(exact ? [] : [{ kind: "custom" as const, value }]),
    ...filtered.slice(0, MAX_VISIBLE).map((choice) => ({
      kind: "choice" as const,
      value: choice.model,
      choice,
    })),
  ];
  const hidden = filtered.length - Math.min(filtered.length, MAX_VISIBLE);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) =>
      trimmed === "" ? option.kind === "default" : option.value.trim() === trimmed,
    ),
  );

  const show = () => {
    if (open) return;
    setQuery(null);
    setActive(selectedIndex);
    setOpen(true);
  };

  useEffect(() => {
    if (requested.current !== harness) requested.current = null;
    if (!requested.current || !discovery || discovery.loading) return;
    requested.current = null;
    if (discovery.error || !discovery.result?.models.length) return;
    input.current?.focus();
    setQuery(null);
    setOpen(true);
  }, [harness, discovery]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (option: Option) => {
    onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + delta + options.length) % options.length);
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(options[active] ?? options[0]!);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Tab") setOpen(false);
  };

  const optionText = (option: Option) => {
    if (option.kind === "default") return NATIVE_DEFAULT_LABEL;
    if (option.kind === "custom")
      return trimmed ? `Custom id: ${trimmed}` : "Custom id: type an exact model id";
    return option.choice.label;
  };

  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row model-select" ref={wrapper}>
        <div className="combobox grow">
          <input
            ref={input}
            id={id}
            className="input mono"
            role="combobox"
            aria-label={ariaLabel}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-haspopup="listbox"
            aria-activedescendant={open ? `${listId}-${active}` : undefined}
            aria-describedby={statusId}
            aria-invalid={!validModel(trimmed || null)}
            autoComplete="off"
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(event) => {
              onChange(event.target.value);
              setQuery(event.target.value);
              setOpen(true);
              setActive(1);
            }}
            onFocus={show}
            onBlur={() => setOpen(false)}
            onClick={show}
            onKeyDown={onKeyDown}
          />
          {open && !disabled && (
            <ul
              className="combobox-list"
              role="listbox"
              id={listId}
              aria-label={`${ariaLabel} choices`}
            >
              {options.map((option, index) => (
                <li
                  key={option.kind === "choice" ? `choice-${option.value}` : option.kind}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-description={
                    option.kind === "choice"
                      ? isCatalogChoice(option.choice, discovery?.result)
                        ? "Catalog entry"
                        : "Configured or saved ID, not a catalog entry"
                      : undefined
                  }
                  aria-selected={
                    option.kind === "choice"
                      ? option.value === trimmed
                      : option.kind === "default"
                        ? trimmed === ""
                        : false
                  }
                  className={`combobox-option${index === active ? " active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(option)}
                >
                  <span className={option.kind === "choice" ? undefined : "faint"}>
                    {optionText(option)}
                  </span>
                  {option.kind === "choice" && (
                    <span className="faint small" aria-hidden="true">
                      {isCatalogChoice(option.choice, discovery?.result)
                        ? "Catalog"
                        : "Configured/saved"}
                    </span>
                  )}
                  {option.kind === "choice" && option.choice.label !== option.value && (
                    <span className="mono faint small">{option.value}</span>
                  )}
                </li>
              ))}
              {hidden > 0 && (
                <li className="combobox-note small faint" role="presentation">
                  {hidden} more match; keep typing to narrow the list.
                </li>
              )}
              {discovery?.result && choices.length > 0 && filtered.length === 0 && (
                <li className="combobox-note small faint" role="presentation">
                  No discovered {harnessLabel[harness]} choice matches; the custom id above is kept.
                </li>
              )}
            </ul>
          )}
        </div>
        <button
          type="button"
          className="button small"
          disabled={disabled || discovery?.loading === true}
          aria-label={`${discovery?.result ? "Refresh" : "Discover"} ${ariaLabel} choices`}
          onClick={() => {
            requested.current = harness;
            onDiscover();
          }}
        >
          {discovery?.loading
            ? "Discovering..."
            : discovery?.result
              ? "Refresh models"
              : "Discover models"}
        </button>
      </div>
      <DiscoveryStatus id={statusId} harness={harness} discovery={discovery} exact={exact} />
    </div>
  );
}

function DiscoveryStatus({
  id,
  harness,
  discovery,
  exact,
}: {
  id: string;
  harness: HarnessId;
  discovery: ModelDiscoveryState | undefined;
  exact: HarnessModelChoice | undefined;
}) {
  const name = harnessLabel[harness];
  const result = discovery?.result ?? null;
  const catalogCount = result?.models.filter((model) => isCatalogChoice(model, result)).length ?? 0;
  const cached = result?.sources.some(
    (source) =>
      source.kind === "cached_catalog" &&
      source.status !== "missing" &&
      source.status !== "unsupported",
  );
  return (
    <div id={id} className="small faint model-status">
      {exact && exact.label !== exact.model && (
        <div>
          Selected <strong>{exact.label}</strong> · <span className="mono">{exact.model}</span>
        </div>
      )}
      {discovery?.loading && <div>Discovering {name} model choices...</div>}
      {discovery?.error && (
        <div style={{ color: "var(--danger)" }}>
          {result ? "Refresh failed" : "Discovery failed"}
          {discovery.failedAt ? ` at ${formatDate(discovery.failedAt)}` : ""}: {discovery.error}
          {result ? ". Showing the previous discovery below." : ""}
        </div>
      )}
      {!discovery && (
        <div>Type a model id or discover {name} choices. Nothing is discovered automatically.</div>
      )}
      {result && (
        <details>
          <summary>
            {discovery?.error ? "Previous discovery" : "Discovery"} at{" "}
            {formatDate(result.checkedAt)}:{" "}
            <Pill
              plain
              tone={
                result.status === "ready"
                  ? "ok"
                  : result.status === "partial"
                    ? "warn"
                    : result.status === "error"
                      ? "danger"
                      : "neutral"
              }
            >
              {result.status}
            </Pill>{" "}
            {result.models.length} {result.models.length === 1 ? "choice" : "choices"} for {name}.
            {catalogCount} catalog; {result.models.length - catalogCount} configured/saved only.
            Account availability not checked
            {cached ? "; cached catalog may be stale" : ""}.
          </summary>
          <p className="discovery-note">
            Catalog entries are separate from retained configured/saved IDs. Claude/Codex use
            credential-free native metadata in a disposable home; Pi reads static local files.
            Account catalogs and effective provider policy are not checked. A listed id is not proof
            of access, mode compatibility or readiness; any valid custom id can still be saved.
          </p>
          <ul className="discovery-sources" aria-label={`${name} discovery sources`}>
            {result.sources.map((source) => (
              <li key={source.id}>
                <Pill plain tone={sourceTone[source.status]}>
                  {source.status}
                </Pill>{" "}
                <span className="mono">{source.id}</span> {source.message}
                {source.path ? (
                  <>
                    {" "}
                    <span className="mono">{source.path}</span>
                  </>
                ) : null}
                {source.modifiedAt ? ` File time ${formatDate(source.modifiedAt)}.` : ""}
                {source.freshness === "unknown" && source.status !== "unsupported"
                  ? " Freshness unknown."
                  : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
