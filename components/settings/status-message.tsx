"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/** Mirrors the Message shape in components/incidents/report-editor.tsx. */
export type Message = { text: string; tone: "info" | "error" };

/**
 * The one status live region per settings card. Always mounted (empty when
 * idle) so assistive tech reliably announces changes. Errors get the error
 * color token and role="alert". Focusable so save bars can hand focus here
 * when they unmount.
 */
export function StatusMessage({
  message,
  className,
  ref,
}: {
  message: Message | null;
  className?: string;
  ref?: React.Ref<HTMLParagraphElement>;
}) {
  return (
    <p
      ref={ref}
      tabIndex={-1}
      aria-live="polite"
      role={message?.tone === "error" ? "alert" : undefined}
      className={cn(
        "min-h-5 text-[13px] outline-none",
        message?.tone === "error" ? "text-[var(--down-text)]" : "text-[var(--fg-muted)]",
        className,
      )}
    >
      {message?.text ?? ""}
    </p>
  );
}
