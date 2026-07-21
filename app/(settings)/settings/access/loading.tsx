import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton"

export default function AccessSettingsLoading() {
  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">Access</h1>
      <SettingsCardsSkeleton
        heights={["h-[320px]", "h-56", "h-64"]}
        label="Loading access settings"
      />
    </>
  )
}
