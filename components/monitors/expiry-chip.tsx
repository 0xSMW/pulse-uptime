import { TriangleAlert } from "lucide-react"

import {
  daysUntil,
  type ExpiryLevel,
  expiryLevel,
} from "@/lib/domain-health/expiry"
import { cn } from "@/lib/utils"

export interface ExpiryWarning {
  kind: "cert" | "domain"
  days: number
  level: Extract<ExpiryLevel, "warning" | "critical">
}

/**
 * The single most urgent expiry warning across the certificate and domain
 * facts, or null when everything is healthy or unknown. One chip per monitor:
 * two simultaneous warnings show only the sooner one, and the detail card
 * carries the rest.
 */
export function expiryWarning(
  certExpiresAt: string | null,
  domainExpiresAt: string | null,
  now: Date
): ExpiryWarning | null {
  const candidates: ExpiryWarning[] = []
  for (const [kind, value] of [
    ["cert", certExpiresAt],
    ["domain", domainExpiresAt],
  ] as const) {
    if (!value) {
      continue
    }
    const expiresAt = new Date(value)
    if (Number.isNaN(expiresAt.getTime())) {
      continue
    }
    const level = expiryLevel(expiresAt, now)
    if (level === "ok") {
      continue
    }
    candidates.push({ kind, days: daysUntil(expiresAt, now), level })
  }
  candidates.sort((left, right) => left.days - right.days)
  return candidates[0] ?? null
}

export function ExpiryChip({ warning }: { warning: ExpiryWarning }) {
  const overdue = warning.days < 0
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-data font-medium text-[11px]",
        warning.level === "critical"
          ? "bg-[var(--down-bg)] text-[var(--down-text)]"
          : "bg-[var(--verifying-bg)] text-[var(--verifying-text)]"
      )}
      title={
        overdue
          ? `${warning.kind === "cert" ? "Certificate" : "Domain"} expired ${-warning.days}d ago`
          : `${warning.kind === "cert" ? "Certificate" : "Domain"} expires in ${warning.days}d`
      }
    >
      <TriangleAlert aria-hidden className="size-3" />
      {warning.kind} {overdue ? "expired" : `${warning.days}d`}
    </span>
  )
}
