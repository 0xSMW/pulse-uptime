/**
 * Neutral (not-outage) card shown on the public status surfaces when the
 * database is unreachable or not yet migrated. Deliberately uses the same
 * "informational" tint as the maintenance tier rather than the red outage
 * styling: a status page being unable to reach its own database is not
 * itself an outage of the monitored services.
 */
export function StatusUnavailableNotice() {
  return (
    <section
      role="status"
      aria-label="Status unavailable"
      className="rounded-xl border border-[var(--border-strong)] bg-[var(--chip-bg)] p-6"
    >
      <h2 className="text-sm font-semibold">Status information is temporarily unavailable</h2>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        We&rsquo;re working to restore it — refresh in a moment.
      </p>
    </section>
  );
}
