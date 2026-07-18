import { cn } from "@/lib/utils";

export function HelpDemoFrame({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <figure
      role="group"
      aria-label={`Example: ${label}`}
      className={cn(
        "overflow-hidden rounded-[8px] border border-[var(--border-strong)]",
        className,
      )}
    >
      <figcaption className="flex items-baseline gap-2 border-b border-[var(--border)] bg-[var(--code-bg)] px-4 py-2">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-[var(--fg-faint)] uppercase">
          Example
        </span>
        <span className="truncate text-xs text-[var(--fg-muted)]">{label}</span>
      </figcaption>
      <div className="p-4 sm:p-5">{children}</div>
    </figure>
  );
}
