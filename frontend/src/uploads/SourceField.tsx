import { useId, useState } from "react";
import type { SourceSummary } from "./api";
import { COPY } from "./copy";
import { versionChip } from "./display";
import { findSource, suggestSources } from "./sources";

interface Props {
  value: string;
  sources: SourceSummary[];
  disabled: boolean;
  onChange: (value: string) => void;
  onPick: (source: string) => void;
}

export function SourceField({ value, sources, disabled, onChange, onPick }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = value.trim();
  const items = open
    ? [
        ...suggestSources(sources, value).map((summary) => ({ source: summary.source, summary })),
        ...(typed && !findSource(sources, typed) ? [{ source: typed, summary: null }] : []),
      ]
    : [];
  const choose = (source: string) => {
    onPick(source);
    setOpen(false);
    setActive(-1);
  };
  return (
    <div className="source-combo">
      <input
        role="combobox"
        aria-label={COPY.file.fields.source}
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 && items[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={value}
        disabled={disabled}
        placeholder="my_source"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && items.length) {
            event.preventDefault();
            setActive((current) => (current + 1) % items.length);
          } else if (event.key === "ArrowUp" && items.length) {
            event.preventDefault();
            setActive((current) => (current <= 0 ? items.length - 1 : current - 1));
          } else if (event.key === "Enter" && items[active]) {
            event.preventDefault();
            choose(items[active].source);
          } else if (event.key === "Escape") setOpen(false);
        }}
      />
      {items.length > 0 && (
        <ul className="source-options" role="listbox" id={listId}>
          {items.map(({ source, summary }, index) => (
            <li
              key={summary ? source : `new:${source}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(source)}
            >
              {summary ? (
                <>
                  <b>{source}</b>{" "}
                  <span className="chip chip-version">
                    {versionChip({ version: summary.current_version, current: true })}
                  </span>
                  <small>
                    {COPY.source.updated} {summary.updated_at.slice(0, 10)}
                  </small>
                </>
              ) : (
                <>
                  <span className="chip chip-new">{COPY.source.newSource}</span> {COPY.source.use} “{source}”
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
