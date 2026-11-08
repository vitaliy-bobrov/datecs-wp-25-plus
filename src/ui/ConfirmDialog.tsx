import { type ReactNode, useEffect, useId, useRef } from 'react';

type ConfirmTone = 'primary' | 'danger';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  confirmTone: ConfirmTone;
  confirmDisabled?: boolean;
  confirmReason?: string;
  busy?: boolean;
  children: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  confirmTone,
  confirmDisabled = false,
  confirmReason,
  busy = false,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const commitBlocked = busy || confirmDisabled;
  const reasonText = confirmReason ?? 'Complete the required confirmation to continue.';
  const reasonVisible = confirmDisabled;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="modal-panel">
        <h2 id={titleId}>{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="button-row modal-actions">
          {reasonVisible ? (
            <p className="modal-reason" id={reasonId}>
              {reasonText}
            </p>
          ) : null}
          <button
            ref={cancelRef}
            type="button"
            className="button"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`button ${confirmTone}`}
            aria-describedby={reasonVisible ? reasonId : undefined}
            aria-disabled={commitBlocked || undefined}
            onClick={() => {
              if (commitBlocked) return;
              onConfirm();
            }}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
