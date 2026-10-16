import type { ChangeEvent, ReactNode } from "react";
import type { SourceDescription, SourceSummary } from "./api";
import { COPY } from "./copy";
import { DECLARATION_TEXT, DOMAINS, toggleDomain, type UploadErrors, type UploadFormState } from "./form";
import { SourceField } from "./SourceField";
import { filledFrom, sourceKind, versionBanner } from "./sources";

export const emptyForm = (): UploadFormState => ({
  pipeline: "",
  file: null,
  source: "",
  added: new Date().toISOString().slice(0, 10),
  license: "",
  author: "",
  source_ref: "",
  pretty_name: "",
  description: "",
  publisher: "",
  limitations: "",
  domains: [],
  per_record_provenance: false,
  declaration: false,
});

export function FieldError({ text }: { text?: string }) {
  return text ? (
    <small className="error" role="alert">
      {text}
    </small>
  ) : null;
}

interface Props {
  state: UploadFormState;
  errors: UploadErrors;
  disabled: boolean;
  set: <K extends keyof UploadFormState>(key: K, value: UploadFormState[K]) => void;
  sources: SourceSummary[];
  described: SourceDescription | null;
  onPickSource: (source: string) => void;
}

const LABELS = COPY.file.fields;

export function Label({ text, required, optional, chip }: { text: string; required?: boolean; optional?: boolean; chip?: ReactNode }) {
  return (
    <span>
      {text}
      {required && <span className="req"> *</span>}
      {optional && <span className="muted"> {COPY.file.optional}</span>}
      {chip && <> {chip}</>}
    </span>
  );
}

export function MetadataFields({ state, errors, disabled, set, sources, described, onPickSource }: Props) {
  const kind = sourceKind(sources, state.source);
  const current = described && described.source === state.source ? described : null;
  const banner = kind === "existing" && current ? versionBanner(current) : null;
  const chip =
    kind === "existing" ? (
      <span className="chip chip-version">{COPY.source.newVersion}</span>
    ) : kind === "new" ? (
      <span className="chip chip-new">{COPY.source.newSource}</span>
    ) : null;
  const text = (key: "license" | "author" | "source_ref" | "pretty_name" | "publisher") => ({
    value: state[key],
    disabled,
    "aria-invalid": Boolean(errors[key]),
    onChange: (event: ChangeEvent<HTMLInputElement>) => set(key, event.target.value),
  });
  return (
    <>
      <div className="fields">
        <div className="field">
          <Label text={LABELS.source} required chip={chip} />
          <SourceField
            value={state.source}
            sources={sources}
            disabled={disabled}
            invalid={Boolean(errors.source)}
            onChange={(value) => set("source", value)}
            onPick={onPickSource}
          />
          <small className="muted">{COPY.source.shared}</small>
          <FieldError text={errors.source} />
        </div>
        <label className="field">
          <Label text={LABELS.added} required />
          <input type="date" value={state.added} disabled={disabled} onChange={(event) => set("added", event.target.value)} />
          <FieldError text={errors.added} />
        </label>
        <label className="field">
          <Label text={LABELS.license} required />
          <input {...text("license")} placeholder="CC-BY-4.0" />
          <small className="muted">{COPY.source.licenseHint}</small>
          <FieldError text={errors.license} />
        </label>
        <label className="field">
          <Label text={LABELS.author} optional />
          <input {...text("author")} />
          <FieldError text={errors.author} />
        </label>
        <label className="field wide">
          <Label text={LABELS.source_ref} required />
          <input {...text("source_ref")} placeholder="https://" />
          <small className="muted">
            {COPY.source.addressHint} <code>https://…</code>, <code>doi:…</code>, <code>urn:isbn:…</code>
          </small>
          <FieldError text={errors.source_ref} />
        </label>
        <div className="field wide">
          <span>{COPY.source.provenanceLabel}</span>
          <label>
            <input
              type="checkbox"
              checked={state.per_record_provenance}
              disabled={disabled}
              onChange={(event) => set("per_record_provenance", event.target.checked)}
            />{" "}
            {COPY.source.provenance}
          </label>
        </div>
      </div>
      {banner && (
        <div className="banner banner-info" role="status">
          <b>{banner.title}</b> {banner.body}
        </div>
      )}
      <section className="form-section">
        <h3>{COPY.source.sectionTitle}</h3>
        <p className="muted">{banner && current ? filledFrom(current) : COPY.source.sectionSub}</p>
        <div className="fields">
          <label className="field">
            <Label text={LABELS.pretty_name} required />
            <input {...text("pretty_name")} />
            <FieldError text={errors.pretty_name} />
          </label>
          <label className="field">
            <Label text={LABELS.publisher} optional />
            <input {...text("publisher")} />
            <FieldError text={errors.publisher} />
          </label>
          <label className="field wide">
            <Label text={LABELS.description} required />
            <textarea
              rows={3}
              value={state.description}
              disabled={disabled}
              placeholder={COPY.source.descriptionPlaceholder}
              aria-invalid={Boolean(errors.description)}
              onChange={(event) => set("description", event.target.value)}
            />
            <FieldError text={errors.description} />
          </label>
          <div className="field wide">
            <Label text={LABELS.domains} required />
            <div className="domain-chips" role="group" aria-label={LABELS.domains}>
              {DOMAINS.map((domain) => (
                <button
                  type="button"
                  key={domain}
                  className="domain-chip"
                  aria-pressed={state.domains.includes(domain)}
                  disabled={disabled}
                  onClick={() => set("domains", toggleDomain(state.domains, domain))}
                >
                  {domain}
                </button>
              ))}
            </div>
            <FieldError text={errors.domains} />
          </div>
          <label className="field wide">
            <Label text={LABELS.limitations} optional />
            <textarea
              rows={3}
              value={state.limitations}
              disabled={disabled}
              placeholder={COPY.source.limitationsPlaceholder}
              aria-invalid={Boolean(errors.limitations)}
              onChange={(event) => set("limitations", event.target.value)}
            />
            <FieldError text={errors.limitations} />
          </label>
        </div>
      </section>
      <div className="field">
        <span>{LABELS.declaration}</span>
        <label>
          <input
            type="checkbox"
            checked={state.declaration}
            disabled={disabled}
            onChange={(event) => set("declaration", event.target.checked)}
          />{" "}
          {DECLARATION_TEXT}
        </label>
        <FieldError text={errors.declaration} />
      </div>
    </>
  );
}
