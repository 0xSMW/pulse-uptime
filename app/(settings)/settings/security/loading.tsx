export default function SecuritySettingsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading security settings" className="animate-pulse space-y-6">
      <div className="h-9 w-32 rounded bg-[var(--chip-bg)]" />
      <div className="h-80 rounded-xl bg-[var(--chip-bg)]" />
      <div className="h-48 rounded-xl bg-[var(--chip-bg)]" />
    </div>
  );
}
