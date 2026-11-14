"use client"

import type * as React from "react"

import { cn } from "@/lib/utils"

/** Mirrors the Message shape in components/incidents/report-editor.tsx. */
export interface Message {
  text: string
  tone: "info" | "error"
  // Routine success the page already shows. Announced to screen readers only.
  quiet?: boolean
}

/**
 * The one status live region per settings card. Always mounted (empty when
 * idle) so assistive tech reliably announces changes. Errors get the error
 * color token and role="alert". Focusable so save bars can hand focus here
 * when they unmount. Quiet info text stays in the region but is visually
 * hidden.
 */
export function StatusMessage({
  message,
  className,
  ref,
}: {
  message: Message | null
  className?: string
  ref?: React.Ref<HTMLParagraphElement>
}) {
  return (
    <p
      aria-live="polite"
      className={cn(
        "min-h-5 text-[13px] outline-none",
        message?.tone === "error"
          ? "text-[var(--down-text)]"
          : "text-[var(--fg-muted)]",
        className
      )}
      ref={ref}
      role={message?.tone === "error" ? "alert" : undefined}
      tabIndex={-1}
    >
      {message?.quiet && message.tone === "info" ? (
        <span className="sr-only">{message.text}</span>
      ) : (
        // biome-ignore lint/suspicious/noUnnecessaryConditions: message is null when the card is idle
        (message?.text ?? "")
      )}
    </p>
  )
}
