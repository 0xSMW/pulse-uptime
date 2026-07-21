import { IncidentTime } from "@/components/incidents/incident-time"
import type {
  IncidentEvent,
  IncidentEventType,
} from "@/components/incidents/types"

const eventLabels: Record<IncidentEventType, string> = {
  first_failure: "First failed check",
  failure_confirmed: "Failure confirmed",
  outage_queued: "Outage email queued",
  outage_sent: "Outage email sent",
  first_success: "First successful check",
  recovery_confirmed: "Recovery confirmed",
  recovery_queued: "Recovery email queued",
  recovery_sent: "Recovery email sent",
}

// Failure events use the down token, recovery events the up token, and
// notification events the neutral token, matching StatusDot state colors.
const eventDotClasses: Record<IncidentEventType, string> = {
  first_failure: "bg-[var(--down)]",
  failure_confirmed: "bg-[var(--down)]",
  outage_queued: "bg-[var(--neutral-state)]",
  outage_sent: "bg-[var(--neutral-state)]",
  first_success: "bg-[var(--up)]",
  recovery_confirmed: "bg-[var(--up)]",
  recovery_queued: "bg-[var(--neutral-state)]",
  recovery_sent: "bg-[var(--neutral-state)]",
}

export function IncidentEventTrail({ events }: { events: IncidentEvent[] }) {
  return (
    <section
      aria-labelledby="event-trail-title"
      className="rounded-xl border border-[var(--border-strong)] shadow-[var(--card-shadow)]"
    >
      <div className="border-[var(--border)] border-b px-6 py-5">
        <h2
          className="font-semibold text-sm tracking-[-0.28px]"
          id="event-trail-title"
        >
          Event Trail
        </h2>
      </div>
      {events.length > 0 ? (
        <ol className="px-6 py-2">
          {events.map((event, index) => (
            <li
              className="relative flex min-h-14 gap-4 py-3"
              key={`${event.type}-${event.at}`}
            >
              {index < events.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute top-7 left-[4px] h-[calc(100%-12px)] w-px bg-[var(--border-strong)]"
                />
              ) : null}
              <span
                aria-hidden="true"
                className={`mt-1.5 size-[9px] shrink-0 rounded-full ${eventDotClasses[event.type]}`}
              />
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-medium text-[13px]">
                  {eventLabels[event.type]}
                </span>
                <time
                  className="font-data text-[11px] text-[var(--fg-faint)]"
                  dateTime={event.at}
                >
                  <IncidentTime value={event.at} />
                </time>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-6 py-8 text-[13px] text-[var(--fg-muted)]">
          No incident events recorded
        </p>
      )}
    </section>
  )
}
