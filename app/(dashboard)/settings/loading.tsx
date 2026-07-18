export default function SettingsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading settings" className="animate-pulse space-y-6">
      <div className="h-7 w-28 rounded bg-[var(--chip-bg)]" />
      {Array.from({ length: 5 }, (_, index) => <div key={index} className="h-48 rounded-xl bg-[var(--chip-bg)]" />)}
    </div>
  );
}
