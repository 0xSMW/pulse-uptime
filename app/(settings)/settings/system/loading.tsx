import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton";

export default function SystemSettingsLoading() {
  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">System</h1>
      <SettingsCardsSkeleton label="Loading system settings" heights={["h-64"]} />
    </>
  );
}
