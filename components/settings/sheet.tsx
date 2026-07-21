"use client"

import { X } from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { PortalContainerContext } from "@/components/ui/portal-container"
import { cn } from "@/lib/utils"

export function SheetIconButton({
  label,
  disabled = false,
  disabledDescription,
  destructive = false,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  disabledDescription?: string
  destructive?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const tooltipId = useId()

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: focusable wrapper surfaces the disabled reason when the inner button cannot take focus
    <span
      aria-label={
        disabled && disabledDescription
          ? `${label}. ${disabledDescription}`
          : undefined
      }
      className="group relative inline-flex"
      tabIndex={disabled ? 0 : undefined}
    >
      <Button
        aria-describedby={tooltipId}
        aria-label={label}
        className={
          destructive
            ? "text-[var(--down-text)] hover:bg-[var(--down-bg)] hover:text-[var(--down-text)]"
            : undefined
        }
        disabled={disabled}
        onClick={onClick}
        size="icon-sm"
        type="button"
        variant="tertiary"
      >
        {children}
      </Button>
      {/* Right aligned so the nowrap tooltip stays inside the sheet, the
          buttons sit at the sheet's right edge and a centered tooltip would
          extend past it and widen the dialog's scrollable overflow. */}
      <span
        className="pointer-events-none absolute top-[calc(100%+8px)] right-0 z-20 whitespace-nowrap rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1 font-medium text-[var(--fg)] text-xs opacity-0 shadow-[var(--popover-shadow)] transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
        id={tooltipId}
        role="tooltip"
      >
        {label}
      </span>
    </span>
  )
}

export function Sheet({
  title,
  description,
  open,
  onClose,
  closeDisabled = false,
  headerActions,
  children,
  // Full Tailwind width class so each caller can size its own panel. Kept as a
  // whole literal string, not an interpolated value, so Tailwind still emits
  // the arbitrary value.
  widthClassName = "w-[min(480px,100vw)]",
}: {
  title: string
  description?: string
  open: boolean
  onClose: () => void
  closeDisabled?: boolean
  headerActions?: ReactNode
  children: ReactNode
  widthClassName?: string
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  // Popovers inside the sheet portal into the dialog element itself. The
  // dialog lives in the top layer, so content portaled to document.body
  // would paint beneath it and be inert.
  const [portalHost, setPortalHost] = useState<HTMLDialogElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }
    if (open && !dialog.open) {
      dialog.showModal()
    }
    if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      aria-describedby={description ? "settings-sheet-description" : undefined}
      aria-labelledby="settings-sheet-title"
      // overflow-x-hidden overrides the modal dialog's UA overflow auto so
      // nothing inside can ever produce a horizontal scrollbar, the inner
      // content div owns vertical scrolling.
      className={cn(
        "fixed inset-y-0 right-0 left-auto m-0 h-dvh max-w-none overflow-x-hidden border-0 border-[var(--border)] border-l bg-[var(--bg)] p-0 text-[var(--fg)] shadow-[-12px_0_40px_rgb(0_0_0/20%)] backdrop:animate-[sheet-backdrop-in_200ms_ease-out] backdrop:bg-black/45 open:flex open:animate-[sheet-slide-in_200ms_ease-out] open:flex-col motion-reduce:open:animate-none motion-reduce:backdrop:animate-none",
        widthClassName
      )}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
      ref={(node) => {
        dialogRef.current = node
        setPortalHost(node)
      }}
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-[var(--border)] border-b px-6 py-5">
        <div>
          <h2 className="font-semibold text-base" id="settings-sheet-title">
            {title}
          </h2>
          {description ? (
            <p
              className="mt-1 text-[13px] text-[var(--fg-muted)]"
              id="settings-sheet-description"
            >
              {description}
            </p>
          ) : null}
        </div>
        <div className="-mr-2 flex shrink-0 items-center gap-1">
          {headerActions}
          <SheetIconButton
            disabled={closeDisabled}
            disabledDescription="A change is in progress"
            label="Close sheet"
            onClick={onClose}
          >
            <X aria-hidden className="size-4" />
          </SheetIconButton>
        </div>
      </header>
      <PortalContainerContext.Provider value={portalHost}>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5">
          {children}
        </div>
      </PortalContainerContext.Provider>
    </dialog>
  )
}
