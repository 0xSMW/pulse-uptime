function Skeleton({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-md bg-[var(--chip-bg)] ${className}`} />;
}

export default function ReportLoading() {
  return (
    <main
      className="mx-auto w-full max-w-[720px] px-4 pb-16 pt-12 sm:px-6"
      aria-busy="true"
      aria-label="Loading status report"
    >
      <Skeleton className="h-4 w-24" />
      <div className="mt-5 space-y-3">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="mt-6 rounded-xl border border-[var(--border-strong)] p-6">
        <Skeleton className="h-4 w-36" />
        <div className="mt-4 space-y-3">
          {[0, 1].map((row) => (
            <Skeleton key={row} className="h-4 w-full" />
          ))}
        </div>
      </div>
      <div className="mt-6 space-y-5">
        {[0, 1, 2].map((row) => (
          <div key={row} className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    </main>
  );
}
