import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { HealthWarning } from "@/lib/monitoring/types"

// Operator view of the scheduler-loop health on the System settings screen. It
// renders the same warnings the dashboard banner raises (stale, failing) so a
// broken monitoring loop is visible here too, and stays quiet when healthy.
export function MonitoringHealthCard({
  warnings,
}: {
  warnings: HealthWarning[]
}) {
  if (warnings.length === 0) {
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <CardTitle>Monitoring Loop</CardTitle>
          <span className="shrink-0 rounded-full bg-[var(--up-bg)] px-2 py-1 font-medium text-[var(--up-text)] text-xs">
            Running
          </span>
        </CardHeader>
        <CardContent>
          <p className="text-[13px] text-[var(--fg-muted)]">
            Scheduled checks are running on time.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4">
        <CardTitle>Monitoring Loop</CardTitle>
        <span className="shrink-0 rounded-full bg-[var(--down-bg)] px-2 py-1 font-medium text-[var(--down-text)] text-xs">
          Needs attention
        </span>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-[var(--border)]" role="alert">
          {warnings.map((warning) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
              key={warning.code}
            >
              <span className="font-medium text-[13px]">{warning.message}</span>
              <span className="text-[var(--fg-muted)] text-xs">
                {warning.action}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
