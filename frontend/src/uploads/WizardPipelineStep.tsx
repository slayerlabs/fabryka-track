import { formatBytes } from "./bytes";
import { COPY } from "./copy";
import type { Pipelines } from "./usePipelines";

interface Props {
  pipelines: Pipelines;
  selected: string;
  onChoose: (pipeline: string) => void;
}

export function WizardPipelineStep({ pipelines, selected, onChoose }: Props) {
  const empty = pipelines.loaded && !pipelines.error && pipelines.list.length === 0;
  return (
    <section className="panel">
      <h2>{COPY.pipelines.heading}</h2>
      {!pipelines.loaded && <p className="muted">{COPY.pipelines.loading}</p>}
      {pipelines.error && (
        <p className="error" role="alert">
          {pipelines.error}
        </p>
      )}
      {empty && (
        <p className="error" role="alert">
          {COPY.pipelines.empty}
        </p>
      )}
      <div className="mode-cards">
        {pipelines.list.map((pipeline) => (
          <button
            key={pipeline.pipeline}
            type="button"
            className={`mode-card${pipeline.pipeline === selected ? " selected" : ""}`}
            onClick={() => onChoose(pipeline.pipeline)}
          >
            <strong className="mode-card-title">{pipeline.title}</strong>
            {pipeline.description && <span>{pipeline.description}</span>}
            {pipeline.file_requirements && (
              <span className="muted">
                <b>{COPY.pipelines.requirements}:</b> {pipeline.file_requirements}
              </span>
            )}
            {pipeline.max_encoded_bytes ? (
              <span className="muted">
                <b>{COPY.pipelines.limit}:</b> {formatBytes(pipeline.max_encoded_bytes)}
              </span>
            ) : null}
            <span className="mode-card-choose">{COPY.pipelines.choose}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
