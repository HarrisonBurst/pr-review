import { useState, type FormEvent } from "react";
import { api, RequestError } from "../api/client";
import { useApp } from "../app-context";
import { Notice, useToast } from "../components/ui";
import { GitHubHealth } from "./SettingsView";

export function SetupView() {
  const { state, setState, navigate } = useApp();
  const toast = useToast();
  const [repository, setRepository] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"repo" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saveRepo = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("repo");
    setError(null);
    try {
      setState(await api.updateSettings({ repository: repository.trim() }));
      toast(`Watching ${repository.trim()}`);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const importUrl = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("import");
    setError(null);
    try {
      const detail = await api.importPr(url.trim());
      navigate({ name: "pr", id: detail.pr.id });
    } catch (err) {
      setError(err instanceof RequestError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="setup stack">
      <div>
        <h1>Set up your review inbox</h1>
        <p className="lede">
          Choose the GitHub repository whose review requests should land here. Polling stays off
          until you turn it on in Settings.
        </p>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <form className="card" onSubmit={saveRepo}>
        <div className="card-body stack">
          <div className="field">
            <label htmlFor="setup-repo">Repository</label>
            <input
              id="setup-repo"
              className="input mono"
              placeholder="owner/name"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              autoFocus
              required
              pattern="[\w.\-]+/[\w.\-]+"
            />
          </div>
          <div className="row between">
            <span className="small muted">
              Only requests addressed to {state.health.githubUser ?? "you"} are imported.
            </span>
            <button
              type="submit"
              className="button primary"
              disabled={busy !== null || !repository.trim()}
            >
              {busy === "repo" ? "Saving" : "Start watching"}
            </button>
          </div>
        </div>
      </form>
      <form className="card" onSubmit={importUrl}>
        <div className="card-body stack">
          <div className="field">
            <label htmlFor="setup-url">Or import one pull request</label>
            <input
              id="setup-url"
              className="input"
              placeholder="https://github.com/owner/name/pull/123"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              type="url"
              required
            />
          </div>
          <div className="row between">
            <span className="small muted">Its repository becomes the configured one.</span>
            <button type="submit" className="button" disabled={busy !== null || !url.trim()}>
              {busy === "import" ? "Importing" : "Import"}
            </button>
          </div>
        </div>
      </form>
      <section className="card">
        <div className="card-head">
          <h2>Integrations</h2>
        </div>
        <div className="card-body">
          <GitHubHealth health={state.health} />
        </div>
      </section>
    </div>
  );
}
