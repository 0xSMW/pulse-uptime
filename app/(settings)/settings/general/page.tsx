import { Suspense } from "react";

import { GeneralSettings } from "@/components/settings/general-settings";
import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton";
import { getGeneralSettings } from "@/lib/reporting/queries/settings";

export default function GeneralSettingsPage() {
  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">General</h1>
      <Suspense fallback={<SettingsCardsSkeleton label="Loading general settings" heights={["h-48", "h-72"]} />}>
        <GeneralSettingsIsland />
      </Suspense>
    </>
  );
}

async function GeneralSettingsIsland() {
  return <GeneralSettings data={await getGeneralSettings()} />;
}
