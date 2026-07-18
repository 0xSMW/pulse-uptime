import { MonitorsSettings } from "@/components/settings/monitors-settings";
import { getMonitorSettings } from "@/lib/reporting/queries/settings";

export default async function MonitorSettingsPage() {
  const data = await getMonitorSettings();

  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">Monitors</h1>
      <MonitorsSettings data={data} />
    </>
  );
}
