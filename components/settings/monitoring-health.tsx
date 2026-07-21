import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { HealthWarning } from "@/lib/monitoring/types";

// Operator view of the scheduler-loop health on the System settings screen. It
// renders the same warnings the dashboard banner raises (stale, failing) so a
// broken monitoring loop is visible here too, and stays quiet when healthy.
export function MonitoringHealthCard({ warnings }: { warnings: HealthWarning[] }) {
  if (warnings.length === 0) {
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <CardTitle>Monitoring Loop</CardTitle>
          <span className="shrink-0 rounded-full bg-[var(--up-bg)] px-2 py-1 text-xs font-medium text-[var(--up-text)]">Running</span>
        </CardHeader>
        <CardContent>
          <p className="text-[13px] text-[var(--fg-muted)]">Scheduled checks are running on time.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4">
        <CardTitle>Monitoring Loop</CardTitle>
        <span className="shrink-0 rounded-full bg-[var(--down-bg)] px-2 py-1 text-xs font-medium text-[var(--down-text)]">Needs attention</span>
      </CardHeader>
      <CardContent>
        <ul role="alert" className="divide-y divide-[var(--border)]">
          {warnings.map((warning) => (
            <li key={warning.code} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
              <span className="text-[13px] font-medium">{warning.message}</span>
              <span className="text-xs text-[var(--fg-muted)]">{warning.action}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
