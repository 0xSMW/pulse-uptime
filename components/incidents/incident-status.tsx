import { cn } from "@/lib/utils";

export function IncidentStatus({
  ongoing,
  className,
}: {
  ongoing: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium leading-4",
        ongoing
          ? "bg-[var(--down-bg)] text-[var(--down-text)]"
          : "bg-[var(--up-bg)] text-[var(--up-text)]",
        className,
      )}
    >
      {/* Resolved is a completed recovery, so it earns the up green at rest,
          mirroring the ongoing chip's down red. Grey read as inactive. */}
      <span
        aria-hidden="true"
        className={cn(
          "relative size-2 shrink-0 rounded-full",
          ongoing ? "status-dot-pulse bg-[var(--down)] text-[var(--down)]" : "bg-[var(--up)]",
        )}
      />
      {ongoing ? "Ongoing" : "Resolved"}
    </span>
  );
}
