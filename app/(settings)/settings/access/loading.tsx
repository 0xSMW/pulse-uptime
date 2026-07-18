export default function AccessSettingsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading access settings" className="animate-pulse space-y-6">
      <div className="h-[320px] rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-56 rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-64 rounded-xl bg-[var(--chip-bg)]" />
    </div>
  );
}
