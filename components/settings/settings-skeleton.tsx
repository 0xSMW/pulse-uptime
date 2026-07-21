import { cn } from "@/lib/utils"

// Shared by settings loading.tsx files and Suspense fallbacks so the
// navigation skeleton and the streaming fallback are pixel-identical.
export function SettingsCardsSkeleton({
  label,
  heights,
}: {
  label: string
  heights: string[]
}) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="animate-pulse space-y-6"
      role="status"
    >
      {heights.map((height, index) => (
        <div
          className={cn("rounded-xl bg-[var(--chip-bg)]", height)}
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list that never reorders
          key={index}
        />
      ))}
    </div>
  )
}
