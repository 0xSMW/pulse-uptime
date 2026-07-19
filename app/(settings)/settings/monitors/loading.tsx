import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton";

export default function MonitorSettingsLoading() {
  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">Monitors</h1>
      <SettingsCardsSkeleton label="Loading monitor settings" heights={["h-[420px]", "h-48", "h-32"]} />
    </>
  );
}
