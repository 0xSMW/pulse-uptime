"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { PortalContainerContext } from "@/components/ui/portal-container";

export function SheetIconButton({
  label,
  disabled = false,
  disabledDescription,
  destructive = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  disabledDescription?: string;
  destructive?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const tooltipId = useId();

  return (
    <span
      className="group relative inline-flex"
      tabIndex={disabled ? 0 : undefined}
      aria-label={disabled && disabledDescription ? `${label}. ${disabledDescription}` : undefined}
    >
      <Button
        type="button"
        variant="tertiary"
        size="icon-sm"
        className={destructive ? "text-[var(--down-text)] hover:bg-[var(--down-bg)] hover:text-[var(--down-text)]" : undefined}
        disabled={disabled}
        aria-label={label}
        aria-describedby={tooltipId}
        onClick={onClick}
      >
        {children}
      </Button>
      {/* Right aligned so the nowrap tooltip stays inside the sheet, the
          buttons sit at the sheet's right edge and a centered tooltip would
          extend past it and widen the dialog's scrollable overflow. */}
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute top-[calc(100%+8px)] right-0 z-20 rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1 text-xs font-medium whitespace-nowrap text-[var(--fg)] opacity-0 shadow-[var(--popover-shadow)] transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
      >
        {label}
      </span>
    </span>
  );
}

export function Sheet({
  title,
  description,
  open,
  onClose,
  closeDisabled = false,
  headerActions,
  children,
}: {
  title: string;
  description?: string;
  open: boolean;
  onClose: () => void;
  closeDisabled?: boolean;
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Popovers inside the sheet portal into the dialog element itself. The
  // dialog lives in the top layer, so content portaled to document.body
  // would paint beneath it and be inert.
  const [portalHost, setPortalHost] = useState<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={(node) => {
        dialogRef.current = node;
        setPortalHost(node);
      }}
      aria-labelledby="settings-sheet-title"
      aria-describedby={description ? "settings-sheet-description" : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      // overflow-x-hidden overrides the modal dialog's UA overflow auto so
      // nothing inside can ever produce a horizontal scrollbar, the inner
      // content div owns vertical scrolling.
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh w-[min(480px,100vw)] max-w-none overflow-x-hidden border-0 border-l border-[var(--border)] bg-[var(--bg)] p-0 text-[var(--fg)] shadow-[-12px_0_40px_rgb(0_0_0/20%)] backdrop:bg-black/45 open:flex open:flex-col open:animate-[sheet-slide-in_200ms_ease-out] backdrop:animate-[sheet-backdrop-in_200ms_ease-out] motion-reduce:open:animate-none motion-reduce:backdrop:animate-none"
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-5">
        <div>
          <h2 id="settings-sheet-title" className="text-base font-semibold">{title}</h2>
          {description ? <p id="settings-sheet-description" className="mt-1 text-[13px] text-[var(--fg-muted)]">{description}</p> : null}
        </div>
        <div className="-mr-2 flex shrink-0 items-center gap-1">
          {headerActions}
          <SheetIconButton label="Close sheet" disabled={closeDisabled} disabledDescription="A change is in progress" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </SheetIconButton>
        </div>
      </header>
      <PortalContainerContext.Provider value={portalHost}>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-5">{children}</div>
      </PortalContainerContext.Provider>
    </dialog>
  );
}
