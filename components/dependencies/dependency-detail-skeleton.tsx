// Shared by loading.tsx and the page's Suspense fallback, mirroring
// MonitorDetailSkeleton's geometry so the loading-to-content swap never
// shifts layout.
export function DependencyDetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading dependency details">
      <header>
        <div className="mb-5 h-4 w-20 animate-pulse rounded bg-[var(--chip-bg)]" aria-hidden />
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="h-7 w-52 animate-pulse rounded bg-[var(--chip-bg)]" aria-hidden />
              <div className="h-6 w-20 animate-pulse rounded-full bg-[var(--chip-bg)]" aria-hidden />
            </div>
            <div className="mt-2 h-5 w-40 animate-pulse rounded bg-[var(--chip-bg)]" aria-hidden />
          </div>
          <div className="h-9 w-40 animate-pulse rounded-lg bg-[var(--chip-bg)]" aria-hidden />
        </div>
      </header>
      <div className="grid animate-pulse gap-6 md:grid-cols-2">
        <div className="h-40 rounded-xl bg-[var(--chip-bg)]" />
        <div className="h-40 rounded-xl bg-[var(--chip-bg)]" />
      </div>
      <div className="h-40 animate-pulse rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-24 animate-pulse rounded-xl bg-[var(--chip-bg)]" />
    </div>
  );
}
