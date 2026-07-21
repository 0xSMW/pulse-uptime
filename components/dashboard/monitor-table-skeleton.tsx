// Dimension-matched fallback for the MonitorTable island: same search box
// footprint, same table frame and header, shimmer rows at the real row height.
export function MonitorTableSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading monitors" role="status">
      {/* Chrome copied from components/ui/input.tsx (md) so the swap to the
          real search input changes nothing visually. */}
      <div className="mb-4 h-10 animate-pulse rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)]" />
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[960px] border-collapse text-left text-[13px]">
          <thead className="text-[var(--fg-muted)] text-xs">
            <tr className="h-10 border-[var(--border)] border-b">
              <th className="px-6 font-medium">Status</th>
              <th className="px-4 font-medium">Monitor</th>
              <th className="px-4 text-right font-medium">Uptime 24h</th>
              <th className="px-4 font-medium">Timeline</th>
              <th className="px-4 text-right font-medium">Latency</th>
              <th className="px-6 text-right font-medium">Last Checked</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, index) => (
              <tr
                className="h-[60px] border-[var(--border)] border-b last:border-0"
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list that never reorders
                key={index}
              >
                <td className="px-6">
                  <div className="h-4 w-16 animate-pulse rounded bg-[var(--chip-bg)]" />
                </td>
                <td className="px-4">
                  <div className="h-4 w-40 animate-pulse rounded bg-[var(--chip-bg)]" />
                </td>
                <td className="px-4">
                  <div className="ml-auto h-4 w-14 animate-pulse rounded bg-[var(--chip-bg)]" />
                </td>
                <td className="w-[280px] min-w-[220px] px-4">
                  <div className="h-6 animate-pulse rounded bg-[var(--chip-bg)]" />
                </td>
                <td className="px-4">
                  <div className="ml-auto h-4 w-14 animate-pulse rounded bg-[var(--chip-bg)]" />
                </td>
                <td className="px-6">
                  <div className="ml-auto h-4 w-20 animate-pulse rounded bg-[var(--chip-bg)]" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
