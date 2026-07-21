export default function NotificationSettingsLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading notification settings"
      className="animate-pulse space-y-6"
    >
      <div className="h-9 w-40 rounded bg-[var(--chip-bg)]" />
      <div className="h-72 rounded-xl bg-[var(--chip-bg)]" />
    </div>
  )
}
