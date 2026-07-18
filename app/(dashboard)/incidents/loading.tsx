// Mirrors the incidents page shell: real heading, filter-sized block, list
// skeleton — so prefetched navigation feedback matches the streamed shell.
export default function IncidentsLoading() {
  return (
    <>
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Incidents</h1>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)]">Endpoint outage history</p>
        </div>
        <div className="h-[34px] w-[190px] animate-pulse rounded-md bg-[var(--chip-bg)]" aria-hidden />
      </header>
      <div aria-busy="true" aria-label="Loading incidents" className="animate-pulse space-y-6">
        <div className="h-32 rounded-xl bg-[var(--chip-bg)]" />
        <div className="h-80 rounded-xl bg-[var(--chip-bg)]" />
      </div>
    </>
  );
}
