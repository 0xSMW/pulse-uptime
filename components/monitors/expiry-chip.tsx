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
 * Every active expiry warning across the certificate and domain facts,
 * soonest first. Empty when everything is healthy or unknown.
 */
export function expiryWarnings(
  certExpiresAt: string | null,
  domainExpiresAt: string | null,
  now: Date
): ExpiryWarning[] {
  const warnings: ExpiryWarning[] = []
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
    warnings.push({ kind, days: daysUntil(expiresAt, now), level })
  }
  warnings.sort((left, right) => left.days - right.days)
  return warnings
}

function kindLabel(kind: ExpiryWarning["kind"]): string {
  return kind === "cert" ? "Cert" : "Domain"
}

/** The full sentence, e.g. "Domain expires in 1 day" or "Cert expired 2 days ago". */
export function expirySentence(warning: ExpiryWarning): string {
  const noun = kindLabel(warning.kind)
  if (warning.days < 0) {
    const days = -warning.days
    return `${noun} expired ${days} ${days === 1 ? "day" : "days"} ago`
  }
  if (warning.days === 0) {
    return `${noun} expires today`
  }
  return `${noun} expires in ${warning.days} ${warning.days === 1 ? "day" : "days"}`
}

function levelText(level: ExpiryWarning["level"]): string {
  return level === "critical"
    ? "text-[var(--down-text)]"
    : "text-[var(--verifying-text)]"
}

/**
 * Compact warnings for the overview table's URL line: bare colored text, no
 * pill, so the muted line keeps its weight. A single warning is glyph plus
 * countdown, two simultaneous warnings gain their nouns to disambiguate. The
 * full sentence rides in the tooltip.
 */
export function ExpiryInlineWarnings({
  warnings,
}: {
  warnings: ExpiryWarning[]
}) {
  if (warnings.length === 0) {
    return null
  }
  const withNouns = warnings.length > 1
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 font-data font-medium text-[11px]"
      title={warnings.map(expirySentence).join(", ")}
    >
      {warnings.map((warning, index) => (
        <span
          className={cn(
            "inline-flex items-center gap-1",
            levelText(warning.level)
          )}
          key={warning.kind}
        >
          {index > 0 ? (
            <span aria-hidden className="text-[var(--fg-faint)]">
              ·
            </span>
          ) : null}
          <TriangleAlert aria-hidden className="size-3" />
          <span className="sr-only">{expirySentence(warning)}</span>
          <span aria-hidden>
            {withNouns ? `${kindLabel(warning.kind)} ` : ""}
            {warning.days < 0 ? "expired" : `${warning.days}d`}
          </span>
        </span>
      ))}
    </span>
  )
}

/**
 * The detail header chip: a full sentence with room to speak, one chip per
 * active warning. Clicking scrolls to the Domain & Certificate card, which
 * carries the complete facts.
 */
export function ExpiryHeaderChip({ warning }: { warning: ExpiryWarning }) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-data font-medium text-[11px]",
        warning.level === "critical"
          ? "bg-[var(--down-bg)] text-[var(--down-text)]"
          : "bg-[var(--verifying-bg)] text-[var(--verifying-text)]"
      )}
      onClick={() =>
        document
          .getElementById("domain-certificate")
          ?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
      type="button"
    >
      <TriangleAlert aria-hidden className="size-3" />
      {expirySentence(warning)}
    </button>
  )
}
