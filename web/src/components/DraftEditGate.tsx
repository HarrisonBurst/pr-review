import { Notice } from "./ui";

export interface DraftEditing {
  allowed: boolean;
  pending: boolean;
  error: string | null;
  begin: () => void;
}

export function DraftEditGate({ editing }: { editing: DraftEditing }) {
  return editing.allowed ? (
    <p className="small faint">
      Editing is recorded. This draft is permanently manual-only, even after discard or reload.
    </p>
  ) : (
    <Notice
      tone={editing.error ? "danger" : "info"}
      actions={
        <button
          type="button"
          className="button small"
          disabled={editing.pending}
          onClick={editing.begin}
        >
          {editing.pending ? "Recording edit intent" : "Begin editing"}
        </button>
      }
    >
      {editing.error ||
        "Begin editing to record a permanent manual-only hold before changing this draft. Manual preview remains available without editing."}
    </Notice>
  );
}
