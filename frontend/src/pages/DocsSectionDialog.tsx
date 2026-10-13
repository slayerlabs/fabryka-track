import { useEffect, useRef, type ReactNode } from "react";
import "../documentation.css";
import "../docs-section-dialog.css";

interface DocsSectionDialogProps {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}

export function DocsSectionDialog({ labelledBy, onClose, children }: DocsSectionDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLElement>(`#${labelledBy}`)?.focus();
    return () => element?.close();
  }, [labelledBy]);

  return (
    <dialog
      ref={dialog}
      className="docs-section-dialog"
      aria-labelledby={labelledBy}
      onCancel={onClose}
      onClose={(event) => {
        if (!event.currentTarget.open) onClose();
      }}
    >
      <div className="docs-section-dialog-header">
        <button type="button" onClick={onClose} aria-label="Close documentation">Close ×</button>
      </div>
      <div className="docs-articles">
        <div className="docs-article">{children}</div>
      </div>
    </dialog>
  );
}
