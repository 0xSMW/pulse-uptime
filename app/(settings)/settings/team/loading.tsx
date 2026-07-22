import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton"

export default function TeamSettingsLoading() {
  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">Team</h1>
      <SettingsCardsSkeleton
        heights={["h-[280px]", "h-40"]}
        label="Loading team settings"
      />
    </>
  )
}
