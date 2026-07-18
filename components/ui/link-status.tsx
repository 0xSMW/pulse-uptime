"use client";

import { useLinkStatus } from "next/link";

import { cn } from "@/lib/utils";

// Instant click feedback while a navigation is in flight. Must be rendered
// as a child of the <Link> it reports on.
export function LinkPendingPulse({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-current", className)}
    />
  );
}
