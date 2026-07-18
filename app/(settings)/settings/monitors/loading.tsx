export default function MonitorSettingsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading monitor settings" className="animate-pulse space-y-6">
      <div className="h-[420px] rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-48 rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-32 rounded-xl bg-[var(--chip-bg)]" />
    </div>
  );
}
