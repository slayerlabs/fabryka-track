import { Link, useNavigate, useSearchParams } from "react-router";
import { MAX_UPLOAD_LABEL } from "../uploads/form";
import type { UploadPipeline } from "../uploads/api";
import { usePipelines, type Pipelines } from "./Uploads";

const STEPS = ["Pipeline", "File check", "Run", "Results"] as const;

function StepIndicator({ step }: { step: number }) {
  return (
    <ol>
      {STEPS.map((label, index) => (
        <li key={label} aria-current={index + 1 === step ? "step" : undefined}>
          {index + 1}. {label}
          {index + 1 < step ? " ✓" : ""}
        </li>
      ))}
    </ol>
  );
}

function PipelineCards({
  pipelines,
  selected,
  onSelect,
}: {
  pipelines: Pipelines;
  selected: string;
  onSelect: (pipeline: string) => void;
}) {
  if (!pipelines.loaded) return <p className="muted">Loading pipelines…</p>;
  if (pipelines.error)
    return (
      <p className="error" role="alert">
        {pipelines.error}
      </p>
    );
  if (pipelines.list.length === 0)
    return (
      <p className="error" role="alert">
        No upload modes are available right now.
      </p>
    );
  const card = (item: UploadPipeline) => (
    <button
      key={item.pipeline}
      type="button"
      className="secondary"
      aria-pressed={selected === item.pipeline}
      onClick={() => onSelect(item.pipeline)}
    >
      <strong>{item.title}</strong>
      {item.description && <span className="muted">{item.description}</span>}
      {item.file_requirements && <span className="muted">{item.file_requirements}</span>}
      <span className="muted">JSONL or Parquet files up to {MAX_UPLOAD_LABEL}.</span>
    </button>
  );
  return <div className="actions">{pipelines.list.map(card)}</div>;
}

function NextStep({ step, pipeline }: { step: number; pipeline: string }) {
  return (
    <section className="panel">
      <h2>
        Step {step}: {STEPS[step - 1]}
      </h2>
      <p className="muted">Pipeline: {pipeline}</p>
      <p className="muted">This step is not available yet.</p>
      <div className="actions">
        <Link className="secondary" to={`/uploads/new?step=1&pipeline=${encodeURIComponent(pipeline)}`}>
          Back to step 1
        </Link>
      </div>
    </section>
  );
}

export function UploadWizardPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const pipelines = usePipelines();

  const requested = Number.parseInt(params.get("step") ?? "1", 10);
  const step = Number.isInteger(requested) && requested >= 1 && requested <= STEPS.length ? requested : 1;
  const param = params.get("pipeline") ?? "";
  const known = pipelines.list.some((item) => item.pipeline === param);
  const single = pipelines.loaded && !pipelines.error && pipelines.list.length === 1 ? pipelines.list[0].pipeline : "";
  const selected = param || single;
  const effective = pipelines.loaded && param && !known ? 1 : step;
  const chosen = pipelines.list.find((item) => item.pipeline === selected);

  if (!pipelines.loaded) {
    return (
      <section className="panel">
        <div className="eyebrow">Data pipeline</div>
        <h1>New guided upload</h1>
        <StepIndicator step={1} />
        <p className="muted">Loading pipelines…</p>
      </section>
    );
  }
  if (pipelines.error) {
    return (
      <section className="panel">
        <div className="eyebrow">Data pipeline</div>
        <h1>New guided upload</h1>
        <StepIndicator step={1} />
        <p className="error" role="alert">
          {pipelines.error}
        </p>
      </section>
    );
  }

  if (effective > 1 && chosen) return (
    <>
      <section className="panel">
        <Link to="/uploads">← Data uploads</Link>
        <h1>New guided upload</h1>
        <StepIndicator step={effective} />
      </section>
      <NextStep step={effective} pipeline={chosen.pipeline} />
    </>
  );

  return (
    <>
      <section className="panel">
        <Link to="/uploads">← Data uploads</Link>
        <div className="eyebrow">Data pipeline</div>
        <h1>New guided upload</h1>
        <StepIndicator step={1} />
        <h2>Step 1: choose a pipeline</h2>
      </section>
      <section className="panel">
        <PipelineCards
          pipelines={pipelines}
          selected={selected}
          onSelect={(pipeline) => navigate(`/uploads/new?step=1&pipeline=${encodeURIComponent(pipeline)}`)}
        />
        <div className="actions">
          <button
            className="primary"
            type="button"
            disabled={!chosen}
            onClick={() =>
              chosen && navigate(`/uploads/new?step=2&pipeline=${encodeURIComponent(chosen.pipeline)}`)
            }
          >
            Continue
          </button>
        </div>
      </section>
    </>
  );
}
