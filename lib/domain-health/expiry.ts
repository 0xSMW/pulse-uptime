// Warning ladder for domain and certificate expiry, shared by every surface
// so a monitor never shows different severities in different places. Expiry
// facts are warnings on an UP monitor, never a monitor state: an actually
// lapsed certificate fails the scheduled check as TLS_ERROR on its own.
const WARNING_DAYS = 30
const CRITICAL_DAYS = 14

export type ExpiryLevel = "ok" | "warning" | "critical"

export function daysUntil(expiresAt: Date, now: Date): number {
  return Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000)
}

export function expiryLevel(expiresAt: Date, now: Date): ExpiryLevel {
  const days = daysUntil(expiresAt, now)
  if (days < CRITICAL_DAYS) {
    return "critical"
  }
  if (days < WARNING_DAYS) {
    return "warning"
  }
  return "ok"
}
