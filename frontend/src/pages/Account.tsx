import { useState } from "react";
import { useCustom, useCustomMutation } from "@refinedev/core";
import { Link, useSearchParams } from "react-router";
import { useDashboard } from "./DashboardData";

export interface StudioUser {
  id: string;
  username: string;
  huggingface_username?: string | null;
}

function HuggingFaceButton({ link = false }: { link?: boolean }) {
  const { mutateAsync } = useCustomMutation<{ url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const response = await mutateAsync({
        url: "/api/auth/huggingface/start",
        method: "post",
        values: { link },
      });
      window.location.assign(String(response.data.url));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not connect to Hugging Face.",
      );
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="secondary" disabled={busy} onClick={connect}>
        {busy
          ? "Connecting…"
          : link
            ? "Connect Hugging Face"
            : "Sign in with Hugging Face"}
      </button>
    </>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  return (
    <section className="panel" style={{ maxWidth: 480, margin: "35px auto" }}>
      <div className="eyebrow">Your workspace</div>
      <h1>Sign in with Hugging Face</h1>
      <p className="muted">
        Keep datasets and training runs private. Publish selected scores to the
        leaderboard.
      </p>
      {params.get("error") && (
        <p className="error" role="alert">
          {params.get("error")}
        </p>
      )}
      <div
        id="hf-account-info"
        lang="en"
        style={{
          margin: "20px 0 8px",
          padding: 16,
          background: "var(--bg)",
          border: "1px solid var(--line)",
          borderRadius: 8,
        }}
      >
        <strong>Before you start</strong>
        <p className="muted">
          You need a Hugging Face account. Complete these three steps:
        </p>
        <ol style={{ paddingLeft: 22, lineHeight: 1.6 }}>
          <li>
            <a
              href="https://huggingface.co/join"
              target="_blank"
              rel="noopener noreferrer"
            >
              Create a Hugging Face account ↗
            </a>
            , if you do not already have one.
          </li>
          <li>
            Visit the{" "}
            <a
              href="https://huggingface.co/SlayerLab"
              target="_blank"
              rel="noopener noreferrer"
            >
              Slayer Lab profile ↗
            </a>{" "}
            and click <strong>Follow</strong>.
          </li>
          <li>
            <a
              href="https://huggingface.co/SlayerLab"
              target="_blank"
              rel="noopener noreferrer"
            >
              Join the Slayer Lab team on HF ↗
            </a>{" "}
            — request membership in the organization.
          </li>
        </ol>
        <p className="muted">
          Then return here and click “Sign in with Hugging Face”. Following the
          profile does not make you a team member.
        </p>
      </div>
      <HuggingFaceButton />
      <p className="muted">
        Human sign-in uses Hugging Face. Your account is created automatically
        when you first sign in. Agents can{" "}
        <Link to="/agents">create an independent account here</Link>.
      </p>
      <Link to="/leaderboard">Browse the public leaderboard →</Link>
    </section>
  );
}

export function AccountPage() {
  const { query } = useCustom<{ user: StudioUser | null }>({
    url: "/api/auth/me",
    method: "get",
  });
  const { mutateAsync } = useCustomMutation<{
    api_key?: string;
    ok?: boolean;
  }>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dashboard = useDashboard(Boolean(query.data?.data.user));
  async function action(kind: "generate" | "revoke" | "logout") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await mutateAsync({
        url: kind === "logout" ? "/api/auth/logout" : "/api/auth/api-key",
        method: kind === "revoke" ? "delete" : "post",
        values: {},
      });
      if (kind === "logout") {
        window.location.assign("/leaderboard");
        return;
      }
      if (kind === "generate" && result.data.api_key)
        setKey(result.data.api_key);
      else {
        setKey("");
        setMessage("API key revoked.");
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not update your account.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (query.isLoading) return <p role="status">Loading account…</p>;
  if (query.error)
    return (
      <p className="error" role="alert">
        {query.error.message}
      </p>
    );
  const user = query.data?.data.user;
  if (!user) return <LoginPage />;
  return (
    <section className="panel" style={{ maxWidth: 600, margin: "30px auto" }}>
      <div className="eyebrow">Account</div>
      <h1>{user.username}</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p role="status">{message}</p>
      <p>
        Your datasets, notes and model files are private. Public runs share your
        username, run name, scores and mixture percentages, and let signed-in
        users try the saved model. Uploaded filenames and contents stay private.
      </p>
      <div className="actions">
        <Link className="primary" to="/new">
          New training run →
        </Link>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => action("logout")}
        >
          Sign out
        </button>
      </div>
      <div className="divider" />
      <h2>Training runs</h2>
      <p className="muted">
        Your external GPU runs appear here as soon as their tracker event arrives.
        Open a run to see live metrics, logs, checkpoints and artifacts.
      </p>
      {dashboard.error && (
        <p className="error" role="alert">
          Could not load training runs: {dashboard.error.message}
        </p>
      )}
      {dashboard.data?.runs.length ? (
        <div className="account-run-list">
          {dashboard.data.runs.map((run) => {
            const loss = run.latest_metrics["loss"] ?? run.latest_metrics["train/loss"];
            return (
              <Link className="account-run" to={`/run/${run.id}`} key={run.id}>
                <span>
                  <strong>{run.name}</strong>
                  <small>{run.project} · {run.experiment || "training"}</small>
                </span>
                <span className="account-run-meta">
                  <b>{run.state}</b>
                  {run.step != null && <small>step {run.step}</small>}
                  {loss != null && <small>loss {Number(loss).toFixed(4)}</small>}
                </span>
              </Link>
            );
          })}
        </div>
      ) : (
        !dashboard.isLoading && <p className="muted">No training runs yet.</p>
      )}
      <p><Link to="/runs">Open the full run workspace →</Link></p>
      <div className="divider" />
      <h2>Hugging Face</h2>
      {user.huggingface_username ? (
        <p>
          Connected as <b>{user.huggingface_username}</b>.
        </p>
      ) : (
        <>
          <p className="muted">
            Connect your HF account to sign in to this same workspace.
          </p>
          <HuggingFaceButton link />
        </>
      )}
      <div className="divider" />
      <h2>SDK API key</h2>
      <p className="muted">
        Use an API key with the Python tracker. Generating a key replaces the
        previous one.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action("generate");
        }}
      >
        <p className="muted">
            Your active Track session is enough. You do not need to sign in to
            Hugging Face again to generate or rotate this key.
          </p>
        <div className="actions">
          <button className="secondary" disabled={busy}>
            Generate API key
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => action("revoke")}
          >
            Revoke API key
          </button>
        </div>
      </form>
      {key && (
        <div>
          <p>Copy this key now. It is shown only once.</p>
          <label className="field">
            <span>API key</span>
            <input
              readOnly
              value={key}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <p className="muted">
            Set FABRYKA_API_KEY and FABRYKA_API_URL=https://track.fabryka.ai in
            your training environment.
          </p>
        </div>
      )}
    </section>
  );
}
