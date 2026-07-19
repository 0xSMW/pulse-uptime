import { Suspense } from "react";

import { MonitorsSettings } from "@/components/settings/monitors-settings";
import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton";
import { getMonitorSettings } from "@/lib/reporting/queries/settings";

export default function MonitorSettingsPage() {
  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">Monitors</h1>
      <Suspense fallback={<SettingsCardsSkeleton label="Loading monitor settings" heights={["h-[420px]", "h-48", "h-32"]} />}>
        <MonitorSettingsIsland />
      </Suspense>
    </>
  );
}

async function MonitorSettingsIsland() {
  return <MonitorsSettings data={await getMonitorSettings()} />;
}
