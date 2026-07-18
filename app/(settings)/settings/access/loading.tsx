import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton";

export default function AccessSettingsLoading() {
  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">Access</h1>
      <SettingsCardsSkeleton label="Loading access settings" heights={["h-[320px]", "h-56", "h-64"]} />
    </>
  );
}
