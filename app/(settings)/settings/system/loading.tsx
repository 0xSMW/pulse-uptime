import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton"

export default function SystemSettingsLoading() {
  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">System</h1>
      <SettingsCardsSkeleton
        heights={["h-64"]}
        label="Loading system settings"
      />
    </>
  )
}
