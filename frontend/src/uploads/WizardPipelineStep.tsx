import { formatBytes } from "./bytes";
import { COPY } from "./copy";
import { pipelineLimit } from "./form";
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
          <article
            key={pipeline.pipeline}
            className={`mode-card${pipeline.pipeline === selected ? " selected" : ""}`}
            onClick={() => onChoose(pipeline.pipeline)}
          >
            <h3>{pipeline.title}</h3>
            {pipeline.description && <p>{pipeline.description}</p>}
            {pipeline.file_requirements && (
              <p className="muted">
                <strong>{COPY.pipelines.requirements}:</strong> {pipeline.file_requirements}
              </p>
            )}
            <p className="muted">
              <strong>{COPY.pipelines.limit}:</strong> {formatBytes(pipelineLimit(pipeline))}
            </p>
            <div className="actions">
              <button
                className="primary"
                type="button"
                aria-pressed={pipeline.pipeline === selected}
                onClick={(event) => {
                  event.stopPropagation();
                  onChoose(pipeline.pipeline);
                }}
              >
                {COPY.pipelines.choose}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
