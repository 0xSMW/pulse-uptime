export default function SystemSettingsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading system settings" className="animate-pulse space-y-6">
      <div className="h-9 w-32 rounded bg-[var(--chip-bg)]" />
      <div className="h-64 rounded-xl bg-[var(--chip-bg)]" />
    </div>
  );
}
