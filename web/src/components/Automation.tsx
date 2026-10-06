import {
  effectiveAutomation,
  pollingKeyFor,
  type AutomationKey,
  type AutomationMode,
  type AutomationOverrideKey,
  type AutomationOverrides,
  type AutomationPolicy,
} from "../../../shared/contracts";
import { Segmented, Switch } from "./ui";

interface PolicyRow {
  key: AutomationKey;
  label: string;
  description: string;
  requires?: AutomationKey;
}

export const policyGroups: { title: string; rows: PolicyRow[] }[] = [
  {
    title: "Commits",
    rows: [
      {
        key: "pollCommits",
        label: "Poll for new commits",
        description: "Refreshes tracked pull requests and keeps stale indicators current.",
      },
      {
        key: "reviewNewCommits",
        label: "Auto-review new commits",
        description: "Queues a review when the head commit changes.",
        requires: "pollCommits",
      },
    ],
  },
  {
    title: "Review requests",
    rows: [
      {
        key: "pollRequests",
        label: "Poll for review requests",
        description: "Finds requests addressed to you, including re-requests on the same commit.",
      },
      {
        key: "reviewRequests",
        label: "Auto-review requests",
        description: "Queues a review for each new request or re-request.",
        requires: "pollRequests",
      },
    ],
  },
];

const rowByKey = Object.fromEntries(
  policyGroups.flatMap((group) => group.rows.map((row) => [row.key, row])),
) as Record<AutomationKey, PolicyRow>;

export const BASELINE_NOTE =
  "Turning effective auto-review on refreshes and queues eligible open inbox PRs without a completed review of their current head. Polling must be on and PR overrides apply. Queued and reviewing work is shown in Settings and the Inbox. Existing automatic submission rules apply; Review backlog remains an explicit local-only option for up to five PRs.";

export function inactiveReason(policy: AutomationPolicy, key: AutomationKey): string | null {
  const requires = rowByKey[key].requires;
  return requires && policy[key] && !policy[requires]
    ? `Inactive until "${rowByKey[requires].label}" is on`
    : null;
}

export function summarize(policy: AutomationPolicy): string {
  const polls = [policy.pollCommits && "commits", policy.pollRequests && "review requests"].filter(
    Boolean,
  );
  const reviews = [
    policy.reviewNewCommits && "new commits",
    policy.reviewRequests && "requests",
  ].filter(Boolean);
  const polling = polls.length ? `Polling ${polls.join(" and ")}` : "No background polling";
  const reviewing = reviews.length
    ? `auto-reviewing ${reviews.join(" and ")}`
    : "no automatic reviews";
  return `${polling}; ${reviewing}.`;
}

export function AutomationSettings({
  policy,
  disabled,
  onChange,
}: {
  policy: AutomationPolicy;
  disabled: boolean;
  onChange: (update: Partial<AutomationPolicy>) => void;
}) {
  return (
    <div className="policy-groups">
      {policyGroups.map((group) => (
        <fieldset className="policy-group" key={group.title}>
          <legend>{group.title}</legend>
          {group.rows.map((row) => {
            const inactive = inactiveReason(policy, row.key);
            return (
              <div className="policy-row" key={row.key}>
                <Switch
                  label={row.label}
                  checked={policy[row.key]}
                  disabled={disabled}
                  onChange={(value) => onChange({ [row.key]: value })}
                />
                <span className="policy-desc small faint">
                  {row.description}
                  {inactive && (
                    <span className="policy-inactive" role="status">
                      {inactive}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

const modeOptions: { value: AutomationMode; label: string }[] = [
  { value: "inherit", label: "Inherit" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

export function overrideStatus(
  global: AutomationPolicy,
  overrides: AutomationOverrides,
  key: AutomationOverrideKey,
): { text: string; on: boolean; inactive: boolean } {
  const polling = pollingKeyFor[key];
  const mode = overrides[key];
  const wanted = mode === "inherit" ? global[key] : mode === "on";
  const source =
    mode === "inherit"
      ? `Inherit (global ${global[key] ? "On" : "Off"})`
      : `${wanted ? "On" : "Off"} (this PR)`;
  if (wanted && !global[polling])
    return {
      text: `${source} · inactive because "${rowByKey[polling].label}" is off globally`,
      on: false,
      inactive: true,
    };
  return { text: source, on: wanted, inactive: false };
}

export function AutomationOverridesCard({
  global,
  overrides,
  busy,
  onChange,
}: {
  global: AutomationPolicy;
  overrides: AutomationOverrides;
  busy: boolean;
  onChange: (update: Partial<AutomationOverrides>) => void;
}) {
  const effective = effectiveAutomation(global, overrides);
  const overridden = Object.values(overrides).some((mode) => mode !== "inherit");
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="small muted" data-testid="automation-summary">
        {summarize(effective)}
        {overridden
          ? " Auto-review overrides apply to this pull request."
          : " Inherits the global defaults."}
      </p>
      {policyGroups.map((group) => {
        const [polling, review] = group.rows as [
          PolicyRow,
          PolicyRow & { requires: AutomationKey },
        ];
        const status = overrideStatus(global, overrides, review.key as AutomationOverrideKey);
        return (
          <div className="policy-group compact" key={group.title}>
            <div className="policy-group-title">{group.title}</div>
            <div className="policy-override">
              <span className="policy-label" title={polling.description}>
                {polling.label}
              </span>
              <span className="policy-global small" data-on={global[polling.key]}>
                {global[polling.key] ? "On" : "Off"} · global setting,{" "}
                <a href="#/settings">change in Settings</a>
              </span>
            </div>
            <div className="policy-override">
              <span className="policy-label" id={`policy-${review.key}`} title={review.description}>
                {review.label}
              </span>
              <div className="row wrap" style={{ gap: 8 }}>
                <Segmented
                  label={review.label}
                  value={overrides[review.key as AutomationOverrideKey]}
                  options={modeOptions}
                  disabled={busy}
                  onChange={(mode) => onChange({ [review.key]: mode })}
                />
                <span
                  className={`policy-effective small${status.inactive ? " inactive" : ""}`}
                  data-on={status.on}
                  aria-label={`${review.label}: ${status.text}`}
                >
                  {status.text}
                </span>
              </div>
            </div>
          </div>
        );
      })}
      <p className="small faint">{BASELINE_NOTE}</p>
    </div>
  );
}
