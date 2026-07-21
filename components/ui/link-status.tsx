"use client"

import { useLinkStatus } from "next/link"

import { cn } from "@/lib/utils"

// Instant click feedback while a navigation is in flight. Must be rendered as
// a child of the <Link> it reports on, and the Link needs `relative`: the dot
// is absolutely positioned so mounting it never shifts the label or siblings.
export function LinkPendingPulse({ className }: { className?: string }) {
  const { pending } = useLinkStatus()
  if (!pending) {
    return null
  }
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-1/2 size-1.5 -translate-y-1/2 animate-pulse rounded-full bg-current",
        className
      )}
    />
  )
}
