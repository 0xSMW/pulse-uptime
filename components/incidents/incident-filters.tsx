import Link from "next/link";

import type { IncidentFilter } from "@/components/incidents/types";
import { cn } from "@/lib/utils";

const filters: Array<{ value: IncidentFilter; label: string; href: string }> = [
  { value: "all", label: "All", href: "/incidents" },
  { value: "ongoing", label: "Ongoing", href: "/incidents?filter=ongoing" },
  { value: "resolved", label: "Resolved", href: "/incidents?filter=resolved" },
];

export function IncidentFilters({ active }: { active: IncidentFilter }) {
  return (
    <nav aria-label="Incident status" className="flex rounded-md border border-[var(--border-strong)] p-0.5">
      {filters.map((filter) => (
        <Link
          key={filter.value}
          href={filter.href}
          aria-current={active === filter.value ? "page" : undefined}
          className={cn(
            "rounded px-3 py-1.5 text-xs font-medium text-[var(--fg-muted)] hover:text-[var(--fg)]",
            active === filter.value && "bg-[var(--chip-bg)] text-[var(--fg)]",
          )}
        >
          {filter.label}
        </Link>
      ))}
    </nav>
  );
}
