import Link from "next/link";

import { HealthBanner } from "@/components/dashboard/health-banner";
import { MonitorTable } from "@/components/dashboard/monitor-table";
import { buttonVariants } from "@/components/ui/button";
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
        <Link href="/settings?new-monitor=1" className={buttonVariants()}>
          New Monitor
        </Link>
      </div>
      <MonitorTable monitors={monitors} />
    </>
  );
}
