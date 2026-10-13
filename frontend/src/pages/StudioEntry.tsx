import type { StudioMode } from "./StudioLocation";
export function StudioEntry({ mode, onChange, disabled }: { mode: StudioMode; onChange: (mode: StudioMode) => void; disabled: boolean }) {
  return <div className="studio-entry" role="group" aria-label="Choose how to work">
    {([
      ["beginner", "01", "Beginner", "A guided start", "Choose a profile, build your data mix and review before launching."],
      ["advanced", "02", "Advanced", "Full experiment control", "Exact recipes, Hugging Face imports and training hyperparameters."],
    ] as const).map(([id, number, title, subtitle, body]) => <button key={id} type="button" className="studio-entry-option" aria-pressed={mode === id} disabled={disabled} onClick={() => onChange(id)}><span className="eyebrow">{number} · {subtitle}</span><strong>{title}</strong><span>{body}</span><span className="studio-entry-action">{mode === id ? "Selected" : "Choose this path →"}</span></button>)}
  </div>;
}
