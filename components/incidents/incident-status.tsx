import { cn } from "@/lib/utils"

type ExclusionStatus = "full" | "partial" | null | undefined

const chipClass =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-medium text-xs leading-4"

export function IncidentStatus({
  ongoing,
  className,
}: {
  ongoing: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        chipClass,
        ongoing
          ? "bg-[var(--down-bg)] text-[var(--down-text)]"
          : "bg-[var(--up-bg)] text-[var(--up-text)]",
        className
      )}
    >
      {/* Resolved is a completed recovery, so it earns the up green at rest,
          mirroring the ongoing chip's down red. Grey read as inactive. */}
      <span
        aria-hidden="true"
        className={cn(
          "relative size-2 shrink-0 rounded-full",
          ongoing
            ? "status-dot-pulse bg-[var(--down)] text-[var(--down)]"
            : "bg-[var(--up)]"
        )}
      />
      {ongoing ? "Ongoing" : "Resolved"}
    </span>
  )
}

export function IncidentExclusionBadge({
  status,
}: {
  status?: ExclusionStatus
}) {
  if (!status) {
    return null
  }
  // A false alarm means the site stayed healthy, so it reads green like up.
  if (status === "full") {
    return (
      <span
        className={cn(chipClass, "bg-[var(--up-bg)] text-[var(--up-text)]")}
      >
        <span
          aria-hidden="true"
          className="relative size-2 shrink-0 rounded-full bg-[var(--up)]"
        />
        False alarm
      </span>
    )
  }
  return (
    <span className="inline-flex rounded-full bg-[var(--chip-bg)] px-2 py-0.5 font-medium text-[var(--fg-muted)] text-xs leading-4">
      Partially excluded
    </span>
  )
}

// A resolved, fully excluded incident was never a real outage, so it shows
// one False alarm badge in place of Resolved. Ongoing incidents keep their
// lifecycle badge so later failed checks stay visible.
export function IncidentStateBadges({
  ongoing,
  exclusionStatus,
}: {
  ongoing: boolean
  exclusionStatus?: ExclusionStatus
}) {
  if (!ongoing && exclusionStatus === "full") {
    return <IncidentExclusionBadge status="full" />
  }
  return (
    <>
      <IncidentStatus ongoing={ongoing} />
      <IncidentExclusionBadge status={exclusionStatus} />
    </>
  )
}
