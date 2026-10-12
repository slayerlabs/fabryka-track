import { DECLARATION_TEXT, type UploadErrors, type UploadFormState } from "./form";

const TEXT_FIELDS = [
  {
    key: "license",
    label: "License",
    placeholder: "CC-BY-4.0",
    hint: "Applies to every record that does not carry its own license.",
  },
  { key: "author", label: "Author (optional)", placeholder: undefined, hint: undefined },
  { key: "source_ref", label: "Source reference (optional)", placeholder: "https://", hint: undefined },
] as const;

const MASK_CHOICES = [
  { value: "yes", label: "Yes, mask names" },
  { value: "no", label: "No, keep names" },
] as const;

export const emptyForm = (): UploadFormState => ({
  pipeline: "",
  file: null,
  source: "",
  added: new Date().toISOString().slice(0, 10),
  license: "",
  author: "",
  source_ref: "",
  per_record_provenance: false,
  mask_names: "",
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
}

export function MetadataFields({ state, errors, disabled, set }: Props) {
  return (
    <>
      <div className="fields">
        <label className="field">
          <span>Source</span>
          <input
            value={state.source}
            disabled={disabled}
            placeholder="my_source"
            onChange={(event) => set("source", event.target.value)}
          />
          <small className="muted">Lowercase letters, digits and underscores.</small>
          <FieldError text={errors.source} />
        </label>
        <label className="field">
          <span>Added</span>
          <input
            type="date"
            value={state.added}
            disabled={disabled}
            onChange={(event) => set("added", event.target.value)}
          />
          <FieldError text={errors.added} />
        </label>
        {TEXT_FIELDS.map(({ key, label, placeholder, hint }) => (
          <label className="field" key={key}>
            <span>{label}</span>
            <input
              value={state[key]}
              disabled={disabled}
              placeholder={placeholder}
              onChange={(event) => set(key, event.target.value)}
            />
            {hint && <small className="muted">{hint}</small>}
            <FieldError text={errors[key]} />
          </label>
        ))}
        <div className="field">
          <span>Provenance</span>
          <label>
            <input
              type="checkbox"
              checked={state.per_record_provenance}
              disabled={disabled}
              onChange={(event) => set("per_record_provenance", event.target.checked)}
            />{" "}
            Records carry their own provenance
          </label>
          <small className="muted">When checked, every record must have its own source_ref.</small>
        </div>
      </div>
      <div className="field" role="radiogroup" aria-labelledby="mask-names-label">
        <span id="mask-names-label">Mask personal names?</span>
        {MASK_CHOICES.map(({ value, label }) => (
          <label key={value}>
            <input
              type="radio"
              name="mask_names"
              disabled={disabled}
              checked={state.mask_names === value}
              onChange={() => set("mask_names", value)}
            />{" "}
            {label}{" "}
          </label>
        ))}
        <FieldError text={errors.mask_names} />
      </div>
      <div className="field">
        <span>Declaration</span>
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
