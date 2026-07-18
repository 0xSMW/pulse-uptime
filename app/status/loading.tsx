function Skeleton({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-md bg-[var(--chip-bg)] ${className}`} />;
}

export default function StatusLoading() {
  return (
    <main
      className="mx-auto w-full max-w-[720px] px-4 pb-16 pt-12 sm:px-6"
      aria-busy="true"
      aria-label="Loading system status"
    >
      <div className="mb-6 flex items-center justify-between gap-4">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-14 w-full rounded-xl" />
      <div className="mt-6 rounded-xl border border-[var(--border-strong)] p-6">
        <Skeleton className="h-4 w-28" />
        <div className="mt-6 space-y-6">
          {[0, 1, 2].map((row) => (
            <div key={row} className="grid gap-3 sm:grid-cols-[140px_1fr_64px]">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-6 rounded-xl border border-[var(--border-strong)] p-6">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-6 h-12 w-full" />
      </div>
    </main>
  );
}
