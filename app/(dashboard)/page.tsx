import { HealthBanner } from "@/components/dashboard/health-banner";
import { MonitorTable } from "@/components/dashboard/monitor-table";
import { NewMonitorAction } from "@/components/dashboard/new-monitor-action";
import { getHealthWarnings } from "@/lib/monitoring/health";
import { listDashboardMonitors } from "@/lib/monitoring/queries";

export default async function OverviewPage() {
  const [monitors, warnings] = await Promise.all([
    listDashboardMonitors(),
    getHealthWarnings(),
  ]);

  return (
    <>
      <HealthBanner warnings={warnings} />
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Monitors</h1>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">Public endpoint availability</p>
        </div>
        <NewMonitorAction />
      </div>
      <MonitorTable monitors={monitors} />
    </>
  );
}
