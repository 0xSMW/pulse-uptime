"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const tabs = [
  {
    label: "Outage history",
    href: "/incidents",
    isActive: (pathname: string) => !pathname.startsWith("/incidents/reports"),
  },
  {
    label: "Reports",
    href: "/incidents/reports",
    isActive: (pathname: string) => pathname.startsWith("/incidents/reports"),
  },
] as const;

/**
 * Section tabs. When a ReportEditor is mounted on the page and dirty, its
 * navigation guard (a document-wide click listener) already confirms
 * before these links navigate away, so no separate check is needed here
 * (that would double-confirm). See useNavigationGuard.
 */
export function IncidentsTabs({ className }: { className?: string }) {
  const pathname = usePathname() ?? "/incidents";
  return (
    <nav aria-label="Incidents sections" className={cn("flex gap-5 border-b border-[var(--border)]", className)}>
      {tabs.map((tab) => {
        const active = tab.isActive(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 pb-2.5 text-[13px] font-medium",
              active
                ? "border-[var(--fg)] text-[var(--fg)]"
                : "border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
