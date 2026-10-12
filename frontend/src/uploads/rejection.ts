export interface RejectionInput {
  position: number;
  rule: string;
  field?: string | null;
}

const RECORD_PROBLEMS: Record<string, string> = {
  unparseable: "is not valid JSON.",
  not_an_object: "is not a JSON object.",
  missing_id: "has no id.",
  invalid_id: "has an id that is not a non-blank string or an integer.",
  duplicate_id: "repeats an id used by an earlier record.",
  invalid_text: "has a text that is not a string.",
  empty_text: "has a blank text.",
  source_mismatch: "has a source that differs from the source you entered.",
  invalid_field_type: "has a field of the wrong type.",
  invalid_date: "has a date that is not a valid YYYY-MM-DD date.",
  missing_license: "has no license and no license was entered for the upload.",
  missing_source_ref: "has no source_ref, which this record needs to credit its author or license.",
  source_ref_unresolved: "has a source_ref that cannot be resolved to a source.",
};

export const REJECT_REASONS = Object.keys(RECORD_PROBLEMS);

export function rejectionMessage({ position, rule, field }: RejectionInput) {
  if (rule === "parquet_column") return `The Parquet file has no ${field} column.`;
  const subject = position > 0 ? `Record ${position}` : "A record";
  const problem = RECORD_PROBLEMS[rule];
  if (problem) return `${subject} ${problem}`;
  return `${subject} did not pass the ${rule} check${field ? ` on ${field}` : ""}.`;
}
