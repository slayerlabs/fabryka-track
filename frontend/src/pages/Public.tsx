import { useEffect, useRef, useState } from "react";
import { useCustom, useCustomMutation } from "@refinedev/core";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { request } from "../provider";
import goalsDocument from "./PublicGoals.html?raw";
import trainingHeader from "./PublicTrainingHeader.html?raw";
import trainingDocument from "./PublicTrainingDocument.html?raw";
import researchProtocol from "./PublicResearchProtocol.html?raw";
import agentsIntro from "./PublicAgentsIntro.html?raw";
import agentsLifecycle from "./PublicAgentsLifecycle.html?raw";
export { PublishedBenchmarksPage } from "./PublicPublished";

const stamp = (value?: string) =>
  value ? new Date(value).toLocaleString() : "Not yet";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed. Please try again.";
interface Session {
  user: { username: string } | null;
}
interface LiveTraining {
  id: string;
  name: string;
  state: string;
  target_tokens: number;
  tracking: {
    received_at?: string;
    source_updated_at?: string;
    process_alive: boolean;
    tokens_seen: number;
  };
}
export function GoalsPage() {
  const { query } = useCustom<LiveTraining[]>({
    url: "/api/external-training/live",
    method: "get",
    queryOptions: { refetchInterval: 15000 },
  });
  const runs = query.data?.data || [];
  return (
    <div className="public-goals">
      {runs.length > 0 && (
        <section id="live-training" aria-label="Live training">
          <h2>TRAINING NOW</h2>
          {query.isError ? (
            <p role="status">
              Training progress is temporarily unavailable. Retrying…
            </p>
          ) : (
            runs.map((run) => {
              const t = run.tracking;
              const recent =
                Date.now() - new Date(t.received_at || 0).getTime() < 60000 &&
                Date.now() - new Date(t.source_updated_at || 0).getTime() <
                  120000 &&
                t.process_alive;
              return (
                <article className="record" key={run.id}>
                  <a href={"/run/" + encodeURIComponent(run.id)}>
                    {run.name} → training plots
                  </a>
                  <p>
                    {run.state === "running"
                      ? recent
                        ? "Live"
                        : "Progress feed delayed"
                      : run.state}{" "}
                    · {((t.tokens_seen || 0) / 1e6).toFixed(1)}M /{" "}
                    {(run.target_tokens / 1e9).toFixed(1)}B tokens ·{" "}
                    {((100 * (t.tokens_seen || 0)) / run.target_tokens).toFixed(
                      1,
                    )}
                    %
                  </p>
                </article>
              );
            })
          )}
        </section>
      )}
      <div dangerouslySetInnerHTML={{ __html: goalsDocument }} />
    </div>
  );
}
interface Registration {
  api_key: string;
  agent: { name: string };
  account: { username: string };
}
export function AgentsPage() {
  const [name, setName] = useState(""),
    [result, setResult] = useState<Registration>(),
    [message, setMessage] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);
  const { mutateAsync, mutation } = useCustomMutation<Registration>();
  return (
    <div className="public-agents">
      <div dangerouslySetInnerHTML={{ __html: agentsIntro }} />
      <section>
        <h2>02 / OR CREATE AN AGENT HERE</h2>
        <p>
          This creates a new agent account, even if you are signed in as a
          human.
        </p>
        {!result && (
          <form
            id="signup"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                const response = await mutateAsync({
                  url: "/api/agents/register",
                  method: "post",
                  values: { name },
                });
                setResult(response.data);
                setMessage(
                  "Agent account created. Use the API key for agent requests.",
                );
              } catch (error) {
                setMessage(errorText(error));
              }
            }}
          >
            <label htmlFor="agent-name">Agent display name</label>
            <input
              id="agent-name"
              required
              minLength={2}
              maxLength={80}
              autoComplete="off"
              placeholder="research-agent"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button className="primary" disabled={mutation.isPending}>
              Create agent account
            </button>
          </form>
        )}
        <p role="status">{message}</p>
        {result && (
          <div>
            <p>
              Save this API key now. It grants access to this agent's workspace.
              It is not saved in this browser.
            </p>
            <label htmlFor="agent-key">API key</label>
            <input
              ref={keyInput}
              id="agent-key"
              readOnly
              autoComplete="off"
              value={result.api_key}
            />
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(result.api_key);
                  setMessage("API key copied.");
                } catch {
                  keyInput.current?.select();
                  setMessage("Select and copy the API key.");
                }
              }}
            >
              Copy key
            </button>
            <p>
              Agent: {result.agent.name} | Account: {result.account.username}
            </p>
          </div>
        )}
      </section>
      <div dangerouslySetInnerHTML={{ __html: agentsLifecycle }} />
    </div>
  );
}
interface ResearchNote {
  id: number;
  created_at: string;
  author?: { name: string };
  stage: string;
  kind: string;
  body: string;
  evidence: string[];
}
interface NotesPage {
  notes: ResearchNote[];
  next_before: number | null;
}
function ResearchScratchpad() {
  const auth = useCustom<Session>({ url: "/api/auth/me", method: "get" });
  const signedIn = Boolean(auth.query.data?.data?.user);
  const notes = useCustom<NotesPage>({
    url: "/api/research/rfc-005/notes",
    method: "get",
    queryOptions: { enabled: signedIn, refetchInterval: 15000 },
  });
  const [older, setOlder] = useState<ResearchNote[]>([]),
    [before, setBefore] = useState<number | null | undefined>(),
    [stage, setStage] = useState("readiness"),
    [kind, setKind] = useState("progress"),
    [body, setBody] = useState(""),
    [evidence, setEvidence] = useState(""),
    [message, setMessage] = useState(""),
    [loadingOlder, setLoadingOlder] = useState(false);
  const pending = useRef<{ signature: string; event_id: string } | null>(null);
  const save = useCustomMutation<ResearchNote>();
  const rows = [...(notes.query.data?.data?.notes || []), ...older].filter(
    (note, index, array) =>
      array.findIndex((item) => item.id === note.id) === index,
  );
  const cursor =
    before === undefined ? notes.query.data?.data?.next_before : before;
  async function refresh() {
    setOlder([]);
    setBefore(undefined);
    await notes.query.refetch();
  }
  return (
    <section
      id="scratchpad"
      aria-labelledby="scratchpad-heading"
      style={{
        border: "1px dashed var(--line)",
        padding: 22,
        margin: "28px 0",
      }}
    >
      <h2 id="scratchpad-heading">Research scratchpad / RFC-005</h2>
      <p className="meta">
        Shared research board for your agents: findings, decisions, blockers and
        next steps. Private to your Track account.
      </p>
      <p id="scratch-state" role="status">
        {message ||
          auth.query.error?.message ||
          notes.query.error?.message ||
          (auth.query.isLoading ? (
            "Checking your session…"
          ) : !signedIn ? (
            <>
              Sign in to read and write your research notes.{" "}
              <a href="/login">Sign in</a>
            </>
          ) : rows.length ? (
            "Shared research history. Automatically refreshed every 15 seconds."
          ) : (
            "No research progress recorded yet. Add the first verified finding or next step."
          ))}
      </p>
      {signedIn && (
        <div id="scratch-workspace">
          <div className="actions">
            <button
              className="secondary"
              type="button"
              onClick={() => void refresh()}
            >
              Refresh notes
            </button>
            <a href="/api/research/rfc-005/scratchpad.md">Export for agent</a>
          </div>
          <form
            style={{ margin: "22px 0" }}
            onSubmit={async (event) => {
              event.preventDefault();
              const content = {
                stage,
                kind,
                body,
                evidence: evidence
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean),
              };
              const signature = JSON.stringify(content);
              if (!pending.current || pending.current.signature !== signature)
                pending.current = { signature, event_id: crypto.randomUUID() };
              try {
                await save.mutateAsync({
                  url: "/api/research/rfc-005/notes",
                  method: "post",
                  values: { ...content, event_id: pending.current.event_id },
                });
                pending.current = null;
                setBody("");
                setEvidence("");
                setMessage("Research note saved.");
                await refresh();
              } catch (error) {
                setMessage(errorText(error));
              }
            }}
          >
            <div className="row">
              <label>
                Research stage
                <select
                  value={stage}
                  onChange={(e) => setStage(e.target.value)}
                >
                  {[
                    ["readiness", "Readiness"],
                    ["proxies", "Proxy experiments"],
                    ["scale-check", "250M scale check"],
                    ["main", "Main run"],
                    ["extension", "200B extension"],
                    ["confirmation", "Confirmation"],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Entry type
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {[
                    ["progress", "Progress"],
                    ["finding", "Finding"],
                    ["decision", "Decision"],
                    ["blocker", "Blocker"],
                    ["next-step", "Next step"],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label htmlFor="scratch-body">Research note</label>
            <textarea
              id="scratch-body"
              rows={7}
              maxLength={20000}
              required
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What was checked? What did you learn? What remains uncertain? What should happen next?"
            />
            <label htmlFor="scratch-evidence">
              Evidence links (one HTTPS or HTTP URL per line; up to 10)
            </label>
            <textarea
              id="scratch-evidence"
              rows={2}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="Track runs, commits, papers or artifacts"
            />
            <button className="primary" disabled={save.mutation.isPending}>
              Save research note
            </button>
            <p className="meta">
              Notes append to history. To correct a finding, add a follow-up
              note.
            </p>
          </form>
          <div dangerouslySetInnerHTML={{ __html: researchProtocol }} />
          <div id="scratch-notes" aria-live="polite" style={{ marginTop: 24 }}>
            {rows.map((note) => (
              <div
                key={note.id}
                style={{
                  borderTop: "1px dashed var(--line)",
                  padding: "18px 0",
                  overflowWrap: "anywhere",
                }}
              >
                {note.author && <p>Agent: {note.author.name}</p>}
                <strong>
                  [{note.stage.toUpperCase()}] [{note.kind.toUpperCase()}]
                </strong>
                <p className="meta">{stamp(note.created_at)}</p>
                <p style={{ whiteSpace: "pre-wrap" }}>{note.body}</p>
                {note.evidence.map((url) => (
                  <p key={url}>
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {url}
                    </a>
                  </p>
                ))}
              </div>
            ))}
          </div>
          {cursor && (
            <button
              className="secondary"
              disabled={loadingOlder}
              onClick={async () => {
                setLoadingOlder(true);
                try {
                  const page = await request<NotesPage>(
                    "/api/research/rfc-005/notes?before=" + cursor,
                  );
                  setOlder((items) => [...items, ...page.notes]);
                  setBefore(page.next_before);
                } catch (error) {
                  setMessage(errorText(error));
                } finally {
                  setLoadingOlder(false);
                }
              }}
            >
              Older notes
            </button>
          )}
        </div>
      )}
    </section>
  );
}
export function TrainingGoalPage() {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash)
      document
        .getElementById(decodeURIComponent(hash.slice(1)))
        ?.scrollIntoView();
  }, [hash]);
  return (
    <div className="public-training-goal">
      <div dangerouslySetInnerHTML={{ __html: trainingHeader }} />
      <ResearchScratchpad />
      <div dangerouslySetInnerHTML={{ __html: trainingDocument }} />
    </div>
  );
}
interface Goal {
  id: string;
  state: string;
  objective: string;
  summary: string;
  updated_at: string;
  run_id: string;
  linked_runs: string[];
}
interface GoalEvent {
  id: number;
  created_at: string;
  kind: string;
  message: string;
}
interface GoalList {
  goals: Goal[];
  active_id: string | null;
  engine: null | {
    online: boolean;
    name: string;
    runtime: string;
    heartbeat_at: string;
  };
}
interface GoalDetail {
  goal: Goal;
  events: GoalEvent[];
  has_more: boolean;
}
export function StatusPage() {
  const location = useLocation(),
    navigate = useNavigate();
  const isStatus = location.pathname === "/status";
  const [params, setParams] = useSearchParams();
  const [objective, setObjective] = useState(""),
    [response, setResponse] = useState(""),
    [credential, setCredential] = useState(""),
    [message, setMessage] = useState("");
  const credentialInput = useRef<HTMLInputElement>(null);
  const auth = useCustom<Session>({ url: "/api/auth/me", method: "get" });
  const list = useCustom<GoalList>({
    url: "/api/goals",
    method: "get",
    queryOptions: {
      enabled: Boolean(auth.query.data?.data?.user),
      refetchInterval: 3000,
    },
  });
  const data = list.query.data?.data;
  const selected = data?.goals.some((goal) => goal.id === params.get("goal"))
    ? params.get("goal")!
    : data?.active_id || data?.goals[0]?.id || "";
  const detail = useCustom<GoalDetail>({
    url: "/api/goals/" + selected,
    method: "get",
    queryOptions: {
      enabled: Boolean(selected),
      refetchInterval: 3000,
      queryFn: async ({ signal }) => {
        let after = 0;
        let page = await request<GoalDetail>(
          "/api/goals/" + selected + "?after=0",
          { signal },
        );
        const events = [...page.events];
        while (page.has_more && page.events.length) {
          after = page.events[page.events.length - 1].id;
          page = await request<GoalDetail>(
            "/api/goals/" + selected + "?after=" + after,
            { signal },
          );
          events.push(...page.events);
        }
        return { data: { ...page, events } };
      },
    },
  });
  const action = useCustomMutation<Goal>();
  const connect = useCustomMutation<{ token: string }>();
  const goal = detail.query.data?.data?.goal;
  async function control(actionName: string) {
    if (!goal) return;
    try {
      await action.mutateAsync({
        url: "/api/goals/" + goal.id + "/control",
        method: "post",
        values: {
          action: actionName,
          ...(actionName === "resume" ? { message: response } : {}),
        },
      });
      setMessage("");
      await Promise.all([list.query.refetch(), detail.query.refetch()]);
    } catch (error) {
      setMessage(errorText(error));
    }
  }
  const failure =
    message ||
    auth.query.error?.message ||
    list.query.error?.message ||
    detail.query.error?.message;
  return (
    <div className="public-status">
      <div className="eyebrow">Agent workspace</div>
      <h1>
        {isStatus ? "See what is happening." : "One goal. Visible progress."}
      </h1>
      <p className="muted">
        {isStatus && data && !data.active_id && data.goals.length ? (
          <>
            Review the latest result, or <a href="/goal">set a new goal</a>.
          </>
        ) : isStatus ? (
          "The current goal, the agent’s latest update, and the evidence behind its progress."
        ) : (
          "Set the outcome. Your remote agent picks it up and reports its work here."
        )}
      </p>
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
      {auth.query.isLoading ? (
        <p>Checking your session…</p>
      ) : !auth.query.data?.data?.user ? (
        <section className="card">
          <h2>Sign in to your workspace</h2>
          <p>
            Your goals, agent updates and linked runs are private to your Track
            account.
          </p>
          <a className="button" href="/login">
            Sign in
          </a>
        </section>
      ) : (
        <div className="grid">
          <div>
            {!data?.active_id && !(isStatus && data?.goals.length) && (
              <section className="card">
                <h2>What should the agent achieve?</h2>
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    try {
                      const result = await action.mutateAsync({
                        url: "/api/goals",
                        method: "post",
                        values: { objective },
                      });
                      await list.query.refetch();
                      navigate(
                        "/status?goal=" + encodeURIComponent(result.data.id),
                      );
                    } catch (error) {
                      setMessage(errorText(error));
                    }
                  }}
                >
                  <label htmlFor="objective">
                    Goal and completion criteria
                  </label>
                  <textarea
                    id="objective"
                    required
                    minLength={10}
                    maxLength={20000}
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    placeholder="Describe the outcome, available resources, constraints, and what evidence will show it is done."
                  />
                  <p className="muted">
                    <small>
                      One active goal per account. A blocked goal stays active
                      until you resume or cancel it.
                    </small>
                  </p>
                  <button disabled={action.mutation.isPending}>
                    Start goal
                  </button>
                </form>
              </section>
            )}
            <section className="card">
              {goal ? (
                <>
                  <div className="row">
                    <h2>Current goal</h2>
                    <span
                      className={
                        "badge " + (goal.state === "blocked" ? "warning" : "")
                      }
                    >
                      {goal.state}
                    </span>
                  </div>
                  <p className="objective">{goal.objective}</p>
                  <p className="summary">{goal.summary}</p>
                  <p className="muted">
                    <small>Updated {stamp(goal.updated_at)}</small>
                  </p>
                  {goal.state === "blocked" && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void control("resume");
                      }}
                    >
                      <label htmlFor="resume-message">
                        Answer the blocker or describe what changed
                      </label>
                      <textarea
                        id="resume-message"
                        maxLength={5000}
                        value={response}
                        onChange={(e) => setResponse(e.target.value)}
                      />
                      <button disabled={action.mutation.isPending}>
                        Resume goal
                      </button>
                    </form>
                  )}
                  {!["completed", "failed", "cancelled"].includes(
                    goal.state,
                  ) && (
                    <button
                      className="secondary"
                      disabled={
                        goal.state === "stopping" || action.mutation.isPending
                      }
                      onClick={() => void control("stop")}
                    >
                      {goal.state === "stopping" ? "Stopping…" : "Stop goal"}
                    </button>
                  )}
                </>
              ) : detail.query.isLoading && selected ? (
                <p>Loading goal…</p>
              ) : (
                <>
                  <h2>No goal yet</h2>
                  <p className="muted">
                    Submit a goal to begin. A connected engine will claim it
                    automatically.
                  </p>
                </>
              )}
            </section>
            <section className="card">
              <div className="row">
                <h2>Activity</h2>
                <span role="status">
                  {list.query.isError || detail.query.isError
                    ? "Connection interrupted · retrying"
                    : list.query.isLoading
                      ? "Connecting…"
                      : "Live · refreshed " +
                        new Date(
                          detail.query.dataUpdatedAt ||
                            list.query.dataUpdatedAt,
                        ).toLocaleTimeString()}
                </span>
              </div>
              <ol className="timeline">
                {detail.query.data?.data?.events.map((event) => (
                  <li key={event.id}>
                    <small>
                      {stamp(event.created_at)} · {event.kind}
                    </small>
                    <p>{event.message}</p>
                  </li>
                ))}
              </ol>
              {!detail.query.data?.data?.events.length && (
                <p className="muted">
                  Status updates will appear when the engine starts work.
                </p>
              )}
            </section>
          </div>
          <aside>
            <section className="card">
              <h2>Remote engine</h2>
              {data?.engine ? (
                <>
                  <span
                    className={"badge " + (data.engine.online ? "" : "warning")}
                  >
                    {data.engine.online ? "Connected" : "Offline"}
                  </span>
                  <p>{data.engine.name}</p>
                  <small>
                    {data.engine.runtime || "No runtime connected"}
                    <br />
                    Last heartbeat: {stamp(data.engine.heartbeat_at)}
                  </small>
                </>
              ) : (
                <>
                  <span className="badge warning">Not connected</span>
                  <p className="muted">
                    Connect a remote engine to execute goals.
                  </p>
                </>
              )}
              <details style={{ marginTop: 20 }}>
                <summary>Connect an engine</summary>
                <p className="muted">
                  Run your agent on a separate machine. This credential only
                  grants access to this account’s goal-engine protocol.
                </p>
                <button
                  className="secondary"
                  disabled={
                    connect.mutation.isPending ||
                    data?.goals.some((g) =>
                      ["running", "stopping"].includes(g.state),
                    )
                  }
                  onClick={async () => {
                    try {
                      const result = await connect.mutateAsync({
                        url: "/api/goal-engine/connect",
                        method: "post",
                        values: { name: "Remote goal engine" },
                      });
                      setCredential(result.data.token);
                    } catch (error) {
                      setMessage(errorText(error));
                    }
                  }}
                >
                  Create engine credential
                </button>
                {credential && (
                  <div>
                    <p>
                      Save this credential on the remote machine. It is shown
                      only now. Creating another replaces the previous
                      credential.
                    </p>
                    <label htmlFor="credential">Engine credential</label>
                    <input
                      ref={credentialInput}
                      id="credential"
                      readOnly
                      autoComplete="off"
                      value={credential}
                    />
                    <button
                      className="secondary"
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(credential);
                          setMessage("Credential copied.");
                        } catch {
                          credentialInput.current?.select();
                        }
                      }}
                    >
                      Copy credential
                    </button>
                  </div>
                )}
                <p>
                  <small>
                    Use <code>fabryka-goal-engine</code> with your runtime
                    adapter, or integrate the claim/progress protocol from{" "}
                    <a href="/docs">the API reference</a>.
                  </small>
                </p>
              </details>
            </section>
            <section className="card">
              <h2>Goal history</h2>
              <label htmlFor="history" className="muted">
                View a goal
              </label>
              <select
                id="history"
                value={selected}
                onChange={(e) => {
                  setParams({ goal: e.target.value }, { replace: true });
                  setResponse("");
                }}
              >
                {data?.goals.length ? (
                  data.goals.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.state} · {g.objective.slice(0, 65)}
                    </option>
                  ))
                ) : (
                  <option value="">No goals yet</option>
                )}
              </select>
            </section>
            <section className="card">
              <h2>Connected to Track</h2>
              <p className="muted">
                Every goal has a private Track run. Agent status, results and
                linked training runs stay together.
              </p>
              {goal ? (
                <p>
                  <a href={"/run/" + goal.run_id}>Open goal’s Track run →</a>
                  {(goal.linked_runs || []).map((id) => (
                    <span key={id}>
                      <br />
                      <a href={"/run/" + id}>Training run {id.slice(0, 8)} →</a>
                    </span>
                  ))}
                </p>
              ) : (
                <p className="muted">No run yet.</p>
              )}
            </section>
          </aside>
        </div>
      )}
      <footer>
        Stop requests end the managed agent process. External training jobs keep
        their own stop controls.
      </footer>
    </div>
  );
}
