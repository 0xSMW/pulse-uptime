import { GeneralSettings } from "@/components/settings/general-settings";
import { getGeneralSettings } from "@/lib/reporting/queries/settings";

export default async function GeneralSettingsPage() {
  const data = await getGeneralSettings();

  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">General</h1>
      <GeneralSettings data={data} />
    </>
  );
}
