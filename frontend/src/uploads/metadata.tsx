import { DECLARATION_TEXT, type UploadErrors } from "./form.ts";

export type MetadataValues = {
  source: string;
  added: string;
  license: string;
  author: string;
  source_ref: string;
  per_record_provenance: boolean;
  mask_names: "yes" | "no" | "";
  declaration: boolean;
};

export function FieldError({ text }: { text?: string }) {
  return text ? (
    <small className="error" role="alert">
      {text}
    </small>
  ) : null;
}

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

export function MetadataFields({
  values,
  errors,
  disabled,
  onChange,
}: {
  values: MetadataValues;
  errors: UploadErrors;
  disabled: boolean;
  onChange: (update: Partial<MetadataValues>) => void;
}) {
  return (
    <>
      <div className="fields">
        <label className="field">
          <span>Source</span>
          <input
            value={values.source}
            disabled={disabled}
            placeholder="my_source"
            onChange={(event) => onChange({ source: event.target.value })}
          />
          <small className="muted">Lowercase letters, digits and underscores.</small>
          <FieldError text={errors.source} />
        </label>
        <label className="field">
          <span>Added</span>
          <input
            type="date"
            value={values.added}
            disabled={disabled}
            onChange={(event) => onChange({ added: event.target.value })}
          />
          <FieldError text={errors.added} />
        </label>
        {TEXT_FIELDS.map(({ key, label, placeholder, hint }) => (
          <label className="field" key={key}>
            <span>{label}</span>
            <input
              value={values[key]}
              disabled={disabled}
              placeholder={placeholder}
              onChange={(event) => onChange({ [key]: event.target.value } as Partial<MetadataValues>)}
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
              checked={values.per_record_provenance}
              disabled={disabled}
              onChange={(event) => onChange({ per_record_provenance: event.target.checked })}
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
              checked={values.mask_names === value}
                onChange={() => onChange({ mask_names: value })}
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
            checked={values.declaration}
            disabled={disabled}
            onChange={(event) => onChange({ declaration: event.target.checked })}
          />{" "}
          {DECLARATION_TEXT}
        </label>
        <FieldError text={errors.declaration} />
      </div>
    </>
  );
}
