"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";

export interface ConfirmDialogProps {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive (the "error" button variant). */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * House `<dialog>`-element modal for a single confirm/cancel decision - the
 * repo has no Radix/shadcn Dialog, so this follows the native-element
 * pattern used by GroupDialog and Sheet (see components/settings/
 * group-dialog.tsx and sheet.tsx): a ref-controlled `<dialog>` opened with
 * `showModal()` rather than a portal + focus-trap library.
 *
 * Esc and backdrop click both map to `onCancel` (native `<dialog>` fires
 * `cancel` for both). The Cancel button gets initial focus - a safe default
 * for a destructive confirmation, since it means the do-nothing action is
 * what fires on a stray Enter/Space before the user has read the prompt.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  React.useEffect(() => {
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
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Native `<dialog>` fires a "cancel" event for both Esc and backdrop
        // dismissal. preventDefault stops it from closing itself so onCancel
        // stays the single source of truth.
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        // A click that lands on the <dialog> element itself (not on the
        // <form> content inside it) is a backdrop click - the dialog fills
        // the layout viewport, so the only way to hit the element and miss
        // the form is to click outside the visible card.
        if (event.target === ref.current) onCancel();
      }}
      className="fixed inset-0 z-[95] m-auto w-[min(400px,calc(100vw-32px))] rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] p-5 text-[var(--fg)] shadow-2xl backdrop:bg-black/45"
    >
      <h3 id={titleId} className="text-base font-semibold">{title}</h3>
      {description ? (
        <p id={descriptionId} className="mt-2 text-[13px] text-[var(--fg-muted)]">
          {description}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="button" variant={destructive ? "error" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
