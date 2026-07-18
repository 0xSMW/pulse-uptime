import { Suspense } from "react";

import { AccessSettings } from "@/components/settings/access-settings";
import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton";
import { getAccessSettings } from "@/lib/reporting/queries/settings";

export default function AccessSettingsPage() {
  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">Access</h1>
      <Suspense fallback={<SettingsCardsSkeleton label="Loading access settings" heights={["h-[320px]", "h-56", "h-64"]} />}>
        <AccessSettingsIsland />
      </Suspense>
    </>
  );
}

async function AccessSettingsIsland() {
  return <AccessSettings data={await getAccessSettings()} />;
}
