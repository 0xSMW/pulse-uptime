"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function Sheet({
  title,
  description,
  open,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="settings-sheet-title"
      aria-describedby={description ? "settings-sheet-description" : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh w-[min(480px,100vw)] max-w-none border-0 border-l border-[var(--border)] bg-[var(--bg)] p-0 text-[var(--fg)] shadow-[-12px_0_40px_rgb(0_0_0/20%)] backdrop:bg-black/45 open:flex open:flex-col"
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-5">
        <div>
          <h2 id="settings-sheet-title" className="text-base font-semibold">{title}</h2>
          {description ? <p id="settings-sheet-description" className="mt-1 text-[13px] text-[var(--fg-muted)]">{description}</p> : null}
        </div>
        <button type="button" onClick={onClose} className="-mr-2 size-8 rounded-[6px] text-xl text-[var(--fg-muted)] hover:bg-[var(--hover)]" aria-label="Close sheet">×</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
    </dialog>
  );
}
