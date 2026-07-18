export default function IncidentsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading incidents" className="animate-pulse space-y-6">
      <div className="flex justify-between gap-6"><div className="h-7 w-32 rounded bg-[var(--chip-bg)]" /><div className="h-9 w-52 rounded bg-[var(--chip-bg)]" /></div>
      <div className="h-32 rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-80 rounded-xl bg-[var(--chip-bg)]" />
    </div>
  );
}
