import { SettingsCardsSkeleton } from "@/components/settings/settings-skeleton";

// Mirrors the page shell exactly (real heading, same card skeletons) so the
// prefetched navigation state and the Suspense fallback are indistinguishable.
export default function GeneralSettingsLoading() {
  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">General</h1>
      <SettingsCardsSkeleton label="Loading general settings" heights={["h-48", "h-72"]} />
    </>
  );
}
