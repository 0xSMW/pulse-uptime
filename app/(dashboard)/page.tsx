import { Suspense } from "react";

import { HealthBanner } from "@/components/dashboard/health-banner";
import { MonitorTable } from "@/components/dashboard/monitor-table";
import { MonitorTableSkeleton } from "@/components/dashboard/monitor-table-skeleton";
import { NewMonitorAction } from "@/components/dashboard/new-monitor-action";
import { getHealthWarnings } from "@/lib/monitoring/health";
import { listDashboardMonitors } from "@/lib/monitoring/queries";

export default function OverviewPage() {
  return (
    <>
      {/* Empty fallback: warnings are rare, and layout shift from a
          late-arriving alert banner is acceptable for an alert. */}
      <Suspense fallback={null}>
        <HealthBannerIsland />
      </Suspense>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Monitors</h1>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">Public endpoint availability</p>
        </div>
        <NewMonitorAction />
      </div>
      <Suspense fallback={<MonitorTableSkeleton />}>
        <MonitorTableIsland />
      </Suspense>
    </>
  );
}

async function HealthBannerIsland() {
  return <HealthBanner warnings={await getHealthWarnings()} />;
}

async function MonitorTableIsland() {
  return <MonitorTable monitors={await listDashboardMonitors()} />;
}
