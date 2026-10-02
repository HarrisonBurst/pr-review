import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useImperativeHandle,
  useState,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import type {
  IntegrationHealth,
  PrStatus,
  RunStatus,
  Severity,
  Submission,
} from "../../../shared/contracts";
import { runStatusLabel, statusLabel, submissionLabel } from "../lib/format";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "settled";

export const statusTone: Record<PrStatus, Tone> = {
  unreviewed: "neutral",
  queued: "info",
  reviewing: "accent",
  ready: "ok",
  failed: "danger",
  outdated: "warn",
  submitted: "settled",
};

const runTone: Record<RunStatus, Tone> = {
  queued: "info",
  running: "accent",
  completed: "ok",
  failed: "danger",
  interrupted: "warn",
  unqueued: "neutral",
  cancelled: "warn",
};

const submissionTone: Record<Submission["status"], Tone> = {
  submitting: "accent",
  submitted: "ok",
  uncertain: "warn",
  failed: "danger",
};

export const healthTone: Record<IntegrationHealth["status"], Tone> = {
  ready: "ok",
  unavailable: "warn",
  unknown: "neutral",
  error: "danger",
};

export function Pill({
  tone = "neutral",
  live,
  plain,
  children,
}: {
  tone?: Tone;
  live?: boolean;
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`pill${live ? " live" : ""}${plain ? " plain" : ""}`} data-tone={tone}>
      {children}
    </span>
  );
}

export const StatusPill = ({ status }: { status: PrStatus }) => (
  <Pill tone={statusTone[status]} live={status === "reviewing" || status === "queued"}>
    {statusLabel[status]}
  </Pill>
);

export const StatusDot = ({ status }: { status: PrStatus }) => (
  <span className="status-dot" data-tone={statusTone[status]}>
    <span className="dot" aria-hidden="true" />
    {statusLabel[status]}
  </span>
);

export const RunPill = ({ status }: { status: RunStatus }) => (
  <Pill tone={runTone[status]} live={status === "running" || status === "queued"}>
    {runStatusLabel[status]}
  </Pill>
);

export const SubmissionPill = ({ status }: { status: Submission["status"] }) => (
  <Pill tone={submissionTone[status]} live={status === "submitting"}>
    {submissionLabel[status]}
  </Pill>
);

export const SeverityPill = ({ severity }: { severity: Severity }) => (
  <Pill tone={severity === "blocking" ? "danger" : "warn"}>
    {severity === "blocking" ? "Blocking" : "Non-blocking"}
  </Pill>
);

export function Notice({
  tone = "neutral",
  title,
  children,
  actions,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      className="notice"
      data-tone={tone}
      role={tone === "danger" || tone === "warn" ? "alert" : "status"}
    >
      <div className="grow">
        {title && <strong>{title}</strong>}
        {title && children ? " " : null}
        {children}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function AutoTextarea({
  minRows = 3,
  maxRows = 24,
  className = "",
  value,
  ref: outer,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  minRows?: number;
  maxRows?: number;
  value: string;
  ref?: RefObject<HTMLTextAreaElement | null>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ref.current!, []);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || 20;
    const chrome =
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth);
    el.style.height = "0px";
    const content = el.scrollHeight - chrome;
    const rows = Math.min(maxRows, Math.max(minRows, Math.ceil(content / line)));
    el.style.height = `${rows * line + chrome}px`;
  }, [minRows, maxRows]);
  useLayoutEffect(fit, [fit, value]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(el.parentElement ?? el);
    return () => observer.disconnect();
  }, [fit]);
  return <textarea ref={ref} className={`textarea auto ${className}`} value={value} {...props} />;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  labelledBy,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = ref.current?.querySelector<HTMLElement>(
      "button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])",
    );
    focusable?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const items = Array.from(
          ref.current.querySelectorAll<HTMLElement>(
            "button:not(:disabled), [href], input, textarea, select, [tabindex]:not([tabindex='-1'])",
          ),
        );
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      previous?.focus();
    };
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? id}
        ref={ref}
      >
        <div className="modal-head">
          <h2 id={labelledBy ?? id}>{title}</h2>
          <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  const push = useCallback((message: string, tone: Tone = "neutral") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    const timer = setTimeout(
      () => {
        timers.current.delete(timer);
        setToasts((t) => t.filter((x) => x.id !== id));
      },
      tone === "danger" ? 8000 : 4000,
    );
    timers.current.add(timer);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="toast"
            data-tone={t.tone}
            role={t.tone === "danger" ? "alert" : "status"}
          >
            <span className="grow">{t.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function More({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="disclosure small faint">
      <summary>{label}</summary>
      <div>{children}</div>
    </details>
  );
}

export const Spinner = ({ label = "Loading" }: { label?: string }) => (
  <span className="row" role="status">
    <span className="spinner" aria-hidden="true" />
    <span className="muted">{label}</span>
  </span>
);

export function InlineConfirm({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <div className="inline-confirm" role="alertdialog" aria-label={message}>
      <span className="grow">{message}</span>
      <button type="button" className="button small ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      <button
        type="button"
        className="button small danger solid"
        onClick={onConfirm}
        disabled={busy}
        autoFocus
      >
        {confirmLabel}
      </button>
    </div>
  );
}
