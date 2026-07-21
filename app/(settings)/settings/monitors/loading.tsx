import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton"

export default function MonitorSettingsLoading() {
  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">
        Monitors
      </h1>
      <SettingsCardsSkeleton
        heights={["h-[420px]", "h-48", "h-32"]}
        label="Loading monitor settings"
      />
    </>
  )
}
