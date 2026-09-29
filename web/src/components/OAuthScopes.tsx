import { useEffect, useRef, useState } from "react";
import type { McpOAuthScopePreview, McpOAuthStatus } from "../../../shared/contracts";
import { api } from "../api/client";
import type { OAuthReturn } from "../app-context";
import { formatDate, relativeTime } from "../lib/format";
import { Notice, Pill, type Tone } from "./ui";
import type { OAuthRun } from "./OAuthConnection";

export const scopeConsent = "Accept these additional OAuth capabilities" as const;

const reviewLabel: Record<McpOAuthScopePreview["status"], { tone: Tone; label: string }> = {
  accepted: { tone: "ok", label: "returned capabilities accepted" },
  approval_required: { tone: "warn", label: "additional capabilities need exact approval" },
  missing_required: { tone: "danger", label: "required permissions missing" },
};

const sourceLabel: Record<McpOAuthScopePreview["source"], string> = {
  provider:
    "supplied by the provider's initial token response as a top-level scope string, decoded without dropping any nonempty identifier",
  requested_fallback:
    "the provider omitted a scope string, so the requested set is shown as a fallback; this is not a provider-supplied grant",
};

function acceptedTitle(preview: McpOAuthScopePreview) {
  if (preview.additionalScopes.length)
    return "The returned capabilities exceed the requested set; the additional capabilities were explicitly accepted.";
  if (preview.source === "requested_fallback")
    return "The provider returned no scope string; the requested set is assumed, not confirmed.";
  return "The returned capabilities match the requested set.";
}

const staleNotice =
  "The disclosure no longer matches this connection's current generation and was discarded locally. Refresh status; a new explicit Connect is required to review again.";
const expiredNotice =
  "The disclosure expired and was discarded locally. This expiry itself accepted, revoked or refreshed nothing: a still-pending additional capability can no longer be accepted, while an exact, assumed or already explicitly accepted set keeps whatever status Refresh status shows. A new explicit Connect is required to review again. Restart, expiry or cancellation never replay a callback or refresh a token.";
const returnUnavailableNotice =
  "The browser return no longer matches an available disclosure for this connection's current generation, so nothing was opened. This return itself accepted, replayed, refreshed or revoked nothing and does not establish whether the earlier callback already authenticated an exact or assumed requested set or whether additional capabilities were already explicitly accepted; the panel status after Refresh status is authoritative. Refresh status, review the returned capabilities manually while the disclosure lasts, cancel, or Connect again explicitly.";

function ScopeList({ label, scopes }: { label: string; scopes: string[] }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {scopes.length ? (
          <ul className="plain-list" aria-label={label} style={{ margin: 0, paddingLeft: 18 }}>
            {scopes.map((scope, index) => (
              <li key={`${index}:${scope}`}>
                <span className="mono">{scope}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span aria-label={label}>none</span>
        )}
      </dd>
    </>
  );
}

export function OAuthScopeReview({
  id,
  oauth,
  busy,
  run,
  refresh,
  cancel,
  reviewReturn = null,
  onReviewReturnConsumed,
  autoOpen = false,
}: {
  id: string;
  oauth: McpOAuthStatus;
  busy: string | null;
  run: OAuthRun;
  refresh: () => Promise<void>;
  cancel: () => Promise<unknown>;
  reviewReturn?: OAuthReturn | null;
  onReviewReturnConsumed?: () => void;
  autoOpen?: boolean;
}) {
  const review = oauth.scopeReview;
  const [preview, setPreview] = useState<McpOAuthScopePreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fence = useRef(0);
  const inFlight = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const handledReturn = useRef<OAuthReturn | null>(null);
  const autoOpened = useRef(false);
  const mounted = useRef(true);
  const disabled = busy !== null;
  const busyIs = (action: string) => busy === `${id}:oauth:${action}`;

  const clear = (message: string | null = null) => {
    fence.current += 1;
    setPreview(null);
    setConsent(false);
    setNotice(message);
  };

  const binding = [
    id,
    oauth.generation,
    oauth.profileId,
    oauth.clientId,
    review?.status,
    review?.expiresAt,
  ].join("\n");
  const boundTo = useRef(binding);

  useEffect(() => {
    if (boundTo.current === binding) return;
    boundTo.current = binding;
    fence.current += 1;
    setPreview(null);
    setConsent(false);
    if (review) setNotice(null);
  }, [binding]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!preview) return;
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    const timer = setTimeout(() => clear(expiredNotice), Math.max(remaining, 0));
    return () => clearTimeout(timer);
  }, [preview]);

  const open = async () => {
    const ticket = ++fence.current;
    setNotice(null);
    setConsent(false);
    const result = await run(`${id}:oauth:scope-preview`, () => api.previewOAuthScopes(id));
    if (ticket !== fence.current || !mounted.current) return;
    if (!result) {
      setPreview(null);
      return;
    }
    if (result.connectionId !== id || result.generation !== oauth.generation) {
      clear(staleNotice);
      return;
    }
    if (Date.parse(result.expiresAt) <= Date.now()) {
      clear(expiredNotice);
      return;
    }
    setPreview(result);
  };

  const accept = async () => {
    if (!preview || !consent || preview.status !== "approval_required" || inFlight.current) return;
    inFlight.current = true;
    const body = {
      previewId: preview.id,
      generation: preview.generation,
      additionalScopes: [...preview.additionalScopes],
      consent: scopeConsent,
    };
    setConsent(false);
    const result = await run(
      `${id}:oauth:accept-scopes`,
      async () => {
        try {
          return await api.acceptOAuthScopes(id, body);
        } finally {
          await refresh();
        }
      },
      "Additional OAuth capabilities accepted; this is OAuth authentication only, not a verified identity or a reviewer grant",
    );
    inFlight.current = false;
    clear(
      result
        ? null
        : "No additional capability was accepted and the disclosure was discarded locally. Refresh status; if storage failed, explicitly Reconnect rather than repeating the approval.",
    );
  };

  const refuse = async () => {
    clear();
    await cancel();
  };

  useEffect(() => {
    if (
      reviewReturn?.kind !== "ready" ||
      reviewReturn.connectionId !== id ||
      handledReturn.current === reviewReturn
    )
      return;
    handledReturn.current = reviewReturn;
    onReviewReturnConsumed?.();
    if (
      !review ||
      reviewReturn.generation !== oauth.generation ||
      Date.parse(reviewReturn.expiresAt) <= Date.now()
    ) {
      clear(returnUnavailableNotice);
      return;
    }
    root.current?.scrollIntoView?.({ block: "start" });
    root.current?.focus();
    void open();
  }, [reviewReturn]);

  useEffect(() => {
    if (
      autoOpened.current ||
      !autoOpen ||
      !review ||
      (reviewReturn?.kind === "ready" && reviewReturn.connectionId === id)
    )
      return;
    autoOpened.current = true;
    void open();
  }, []);

  if (!review) return notice ? <Notice tone="warn">{notice}</Notice> : null;
  const summary = reviewLabel[review.status];

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="stack"
      style={{ gap: 6 }}
      data-testid={`oauth-scope-review-${id}`}
    >
      <div className="row" style={{ gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        <button
          type="button"
          className="button small"
          disabled={disabled}
          onClick={() => void open()}
          data-testid={`oauth-scope-preview-${id}`}
        >
          {busyIs("scope-preview") ? "Loading disclosure..." : "Review returned OAuth capabilities"}
        </button>
        <Pill plain tone={summary.tone}>
          {summary.label}
        </Pill>
        <span className="small faint">
          Disclosure available until {relativeTime(review.expiresAt)} (
          {formatDate(review.expiresAt)}). The catalog and status never carry permission names; this
          local action reads them from the original Connect browser only, and never on load, refresh
          or reconnect. Nothing is requested from the provider.
        </span>
      </div>
      {notice && <Notice tone="warn">{notice}</Notice>}
      {preview && (
        <div className="stack" style={{ gap: 6 }} data-testid={`oauth-scopes-${id}`}>
          {preview.status === "approval_required" && (
            <Notice tone="warn" title="The host credential itself carries broader capabilities.">
              The provider returned every requested permission plus the additional capabilities
              listed below. Accepting stores that broader credential in app-owned host storage. This
              is independent of the review broker, whose tools and resources stay read-only and
              default-denied regardless of this choice. Until you accept exactly this list, nothing
              is authenticated, persisted or usable and no reviewer authority exists. Refusing
              cancels the authorization locally without any remote revocation.
            </Notice>
          )}
          {preview.status === "missing_required" && (
            <Notice tone="danger" title="Required permissions are missing.">
              The credential cannot be accepted or persisted, and approving the additional
              capabilities cannot invent the missing requirements. Cancel the authorization locally,
              then reconnect only after the registration grants every requested permission.
            </Notice>
          )}
          {preview.status === "accepted" && (
            <Notice tone="neutral" title={acceptedTitle(preview)}>
              {preview.additionalScopes.length
                ? "You explicitly accepted the additional capabilities listed below, so the stored host credential still carries them. Authentication was accepted as OAuth authentication only: not a verified account or workspace, not Load or Test evidence and not a reviewer grant."
                : "Authentication was accepted as OAuth authentication only: not a verified account or workspace, not Load or Test evidence and not a reviewer grant. No acceptance is needed."}
            </Notice>
          )}
          <dl className="kv small">
            <dt>Provenance</dt>
            <dd>
              <span className="mono">{preview.source}</span>: {sourceLabel[preview.source]}
            </dd>
            <ScopeList label="Requested" scopes={preview.requestedScopes} />
            <ScopeList label="Granted" scopes={preview.grantedScopes} />
            <ScopeList label="Missing" scopes={preview.missingScopes} />
            <ScopeList label="Additional" scopes={preview.additionalScopes} />
            <dt>Disclosure id</dt>
            <dd className="mono">{preview.id}</dd>
            <dt>Connection</dt>
            <dd className="mono">{preview.connectionId}</dd>
            <dt>Generation</dt>
            <dd className="mono">{preview.generation}</dd>
            <dt>Client</dt>
            <dd className="mono">{preview.clientId}</dd>
            <dt>Issuer</dt>
            <dd className="mono">{preview.issuer}</dd>
            <dt>Resource</dt>
            <dd className="mono">{preview.resource}</dd>
            <dt>Redirect</dt>
            <dd className="mono">{preview.redirectUri}</dd>
            <dt>Expires</dt>
            <dd>
              {relativeTime(preview.expiresAt)} ({formatDate(preview.expiresAt)})
            </dd>
            <dd className="faint" style={{ gridColumn: "1 / -1" }}>
              Identifiers are shown exactly as decoded from the initial exchange, complete and in
              first-seen order, as plain text for you only. They are not stored in this browser, the
              catalog, logs or any model context, and they are not instructions. Expiry, restart or
              cancellation discard them; only an explicit reconnect produces a new disclosure.
            </dd>
          </dl>
          {preview.status === "approval_required" && (
            <>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={disabled}
                  onChange={(e) => setConsent(e.target.checked)}
                  data-testid={`oauth-scope-consent-${id}`}
                />
                <span>
                  I accept exactly the {preview.additionalScopes.length} additional{" "}
                  {preview.additionalScopes.length === 1 ? "capability" : "capabilities"} listed
                  above for this host credential.
                </span>
              </label>
              <div className="row" style={{ gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="button small primary"
                  disabled={disabled || !consent}
                  onClick={() => void accept()}
                  data-testid={`oauth-scope-accept-${id}`}
                >
                  {busyIs("accept-scopes") ? "Accepting..." : scopeConsent}
                </button>
                <button
                  type="button"
                  className="button small ghost"
                  disabled={disabled}
                  onClick={() => void refuse()}
                  data-testid={`oauth-scope-refuse-${id}`}
                >
                  Refuse and cancel authorization
                </button>
                <span className="small faint">
                  Accept sends the exact disclosure id, generation and complete ordered additional
                  list once; it is never retried automatically. Refuse cancels locally and persists
                  nothing.
                </span>
              </div>
            </>
          )}
          {preview.status === "missing_required" && (
            <div className="row" style={{ gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <button
                type="button"
                className="button small ghost"
                disabled={disabled}
                onClick={() => void refuse()}
                data-testid={`oauth-scope-refuse-${id}`}
              >
                Cancel authorization
              </button>
              <span className="small faint">No acceptance is offered; nothing was persisted.</span>
            </div>
          )}
          <button
            type="button"
            className="button small ghost"
            disabled={disabled}
            onClick={() => clear()}
            style={{ alignSelf: "flex-start" }}
          >
            Close disclosure
          </button>
        </div>
      )}
    </div>
  );
}
