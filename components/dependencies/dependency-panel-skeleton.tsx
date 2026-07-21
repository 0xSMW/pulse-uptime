// Dimension-matched fallback for the DependencyPanel island. Kept small: the
// panel itself is hidden whenever there are no dependencies, so a heavy
// skeleton would flash and disappear more often than it would ever resolve
// into real rows.
export function DependencyPanelSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading dependencies"
      className="mt-8"
      role="status"
    >
      <div className="h-5 w-32 animate-pulse rounded bg-[var(--chip-bg)]" />
      <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
        {Array.from({ length: 2 }, (_, index) => (
          <div
            className="flex h-[60px] items-center gap-4 border-[var(--border)] border-b px-6 last:border-0"
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list that never reorders
            key={index}
          >
            <div className="h-4 w-16 animate-pulse rounded bg-[var(--chip-bg)]" />
            <div className="h-4 w-40 animate-pulse rounded bg-[var(--chip-bg)]" />
          </div>
        ))}
      </div>
    </div>
  )
}
