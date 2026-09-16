import { Link } from "react-router";
import { RunError, useRunAction, useRunQuery } from "./RunData";

type Publication = {
  status: string;
  url?: string;
  repo_id?: string;
  private?: boolean;
  commit?: string;
  error?: string;
};
type ExportInfo = {
  publication?: Publication;
  hf_username?: string;
  suggested_name: string;
  files: string[];
};
export function RunExport({ id }: { id: string }) {
  const query = useRunQuery<ExportInfo>(
    "/api/training/" + id + "/huggingface",
    (data) => (data?.publication?.status === "uploading" ? 2000 : false),
  );
  const action = useRunAction();
  const data = query.data,
    p = data?.publication;
  return (
    <section className="panel" id="hf-export" style={{ margin: "20px 0" }}>
      <RunError error={query.error} retry={() => void query.refetch()} />
      <RunError error={action.error} />
      {query.isLoading && (
        <p role="status">Loading Hugging Face publication…</p>
      )}
      {p?.status === "finished" ? (
        <>
          <h2>Published to Hugging Face</h2>
          <p>
            <a href={p.url} target="_blank" rel="noopener noreferrer">
              {p.repo_id} ↗
            </a>{" "}
            · {p.private ? "Private" : "Public"}
          </p>
          <p className="muted">
            All uploaded files verified. Commit: {p.commit}
          </p>
        </>
      ) : p?.status === "uploading" ? (
        <>
          <h2>Publishing to SlayerLab…</h2>
          <p className="muted">
            Uploading the model and verifying the committed files. You can
            return to this run later.
          </p>
        </>
      ) : (
        data && (
          <>
            <h2>Publish model to SlayerLab</h2>
            <p>
              Upload the saved checkpoint to the{" "}
              <a
                href="https://huggingface.co/SlayerLab"
                target="_blank"
                rel="noopener noreferrer"
              >
                SlayerLab organization
              </a>
              .
            </p>
            {p?.error && <p className="error">{p.error}</p>}
            {!data.hf_username ? (
              <>
                <p>Connect your Hugging Face account first.</p>
                <Link className="secondary" to="/account">
                  Connect Hugging Face →
                </Link>
              </>
            ) : (
              <>
                <p className="muted">
                  Authorize as {data.hf_username}. Your HF account must be
                  allowed to create models in SlayerLab; select SlayerLab when
                  granting organization access.
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const fields = new FormData(e.currentTarget);
                    const result = await action.execute<{ url: string }>(
                      "/api/training/" + id + "/huggingface",
                      {
                        repo_name: String(fields.get("repo_name")),
                        private: fields.get("visibility") === "private",
                        confirm: true,
                      },
                    );
                    if (result) window.location.assign(result.url);
                  }}
                >
                  <label className="field">
                    <span>Repository name · SlayerLab/</span>
                    <input
                      name="repo_name"
                      required
                      maxLength={80}
                      defaultValue={
                        p?.repo_id?.split("/")[1] || data.suggested_name
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Repository visibility</span>
                    <select
                      name="visibility"
                      defaultValue={p?.private === false ? "public" : "private"}
                    >
                      <option value="private">Private</option>
                      <option value="public">
                        Public — anyone can download
                      </option>
                    </select>
                  </label>
                  <p>Files: {data.files.join(", ")}.</p>
                  <p className="muted">
                    Includes model weights, byte tokenizer configuration,
                    runnable PyTorch code and training metrics. Raw datasets,
                    private filenames, notes and logs are excluded. This creates
                    a new repository; existing models are not overwritten.
                  </p>
                  <button className="primary" disabled={action.pending}>
                    Authorize &amp; publish to SlayerLab →
                  </button>
                </form>
              </>
            )}
          </>
        )
      )}
    </section>
  );
}
