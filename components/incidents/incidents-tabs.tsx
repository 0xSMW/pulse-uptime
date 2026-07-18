"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

import { confirmDiscardUnsaved } from "./report-editor-dirty";

const tabs = [
  {
    label: "Reports",
    href: "/incidents/reports",
    isActive: (pathname: string) => pathname.startsWith("/incidents/reports"),
  },
  {
    label: "Outage history",
    href: "/incidents",
    isActive: (pathname: string) => !pathname.startsWith("/incidents/reports"),
  },
] as const;

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
            onClick={(event) => {
              // The report editor tracks unsaved work in a module-level flag.
              if (!confirmDiscardUnsaved()) event.preventDefault();
            }}
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
