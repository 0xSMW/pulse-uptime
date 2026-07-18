export default function MonitorDetailLoading() {
  return (
    <div aria-busy="true" aria-label="Loading monitor details" className="animate-pulse space-y-6">
      <div className="h-5 w-24 rounded bg-[var(--chip-bg)]" />
      <div className="flex items-center justify-between gap-6">
        <div className="space-y-3"><div className="h-7 w-52 rounded bg-[var(--chip-bg)]" /><div className="h-4 w-80 max-w-full rounded bg-[var(--chip-bg)]" /></div>
        <div className="h-10 w-32 rounded bg-[var(--chip-bg)]" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-24 rounded-xl bg-[var(--chip-bg)]" />)}
      </div>
      <div className="h-48 rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-72 rounded-xl bg-[var(--chip-bg)]" />
    </div>
  );
}
