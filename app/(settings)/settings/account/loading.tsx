import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton"

// Mirrors the page shell exactly (real heading, same card skeletons) so the
// prefetched navigation state and the Suspense fallback are indistinguishable.
export default function AccountSettingsLoading() {
  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">Account</h1>
      <SettingsCardsSkeleton
        heights={["h-64", "h-48"]}
        label="Loading account settings"
      />
    </>
  )
}
