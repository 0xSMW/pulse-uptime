import { Suspense } from "react";

import { DatabaseHealthCard } from "@/components/settings/database-health";
import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton";
import { getSystemSettings } from "@/lib/reporting/queries/settings";

export default function SystemSettingsPage() {
  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">System</h1>
      <Suspense fallback={<SettingsCardsSkeleton label="Loading system settings" heights={["h-64"]} />}>
        <SystemSettingsIsland />
      </Suspense>
    </>
  );
}

async function SystemSettingsIsland() {
  const { databaseHealth, databaseHealthError } = await getSystemSettings();
  return <DatabaseHealthCard initialData={databaseHealth} initialError={databaseHealthError} />;
}
