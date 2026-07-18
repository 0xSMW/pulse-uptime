import { SettingsOverview, type SettingsOverviewData } from "@/components/settings/settings-overview";
import { getSettingsOverview } from "@/lib/reporting/queries/settings";

export default async function SettingsPage() {
  const overview: SettingsOverviewData = await getSettingsOverview();

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Settings</h1>
        <p className="mt-1 text-[13px] text-[var(--fg-muted)]">Monitoring, access, and appearance</p>
      </div>
      <SettingsOverview data={overview} />
    </>
  );
}
