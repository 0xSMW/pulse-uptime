import { cn } from "@/lib/utils"

export function HelpDemoFrame({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <figure
      aria-label={`Example: ${label}`}
      className={cn(
        "overflow-hidden rounded-[8px] border border-[var(--border-strong)]",
        className
      )}
      role="group"
    >
      <figcaption className="flex items-baseline gap-2 border-[var(--border)] border-b bg-[var(--code-bg)] px-4 py-2">
        <span className="font-semibold text-[11px] text-[var(--fg-faint)] uppercase tracking-[0.08em]">
          Example
        </span>
        <span className="truncate text-[var(--fg-muted)] text-xs">{label}</span>
      </figcaption>
      <div className="p-4 sm:p-5">{children}</div>
    </figure>
  )
}
