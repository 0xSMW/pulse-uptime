"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

import { LinkPendingPulse } from "@/components/ui/link-status";
import { cn } from "@/lib/utils";

export const SETTINGS_RETURN_KEY = "pulse:settings-return";

const items = [
  { href: "/settings/general", label: "General" },
  { href: "/settings/monitors", label: "Monitors" },
  { href: "/settings/access", label: "Access" },
  { href: "/settings/system", label: "System" },
] as const;

function storedReturnPath(): string {
  try {
    const stored = window.sessionStorage.getItem(SETTINGS_RETURN_KEY);
    return stored && stored.startsWith("/") && !stored.startsWith("/settings") ? stored : "/";
  } catch {
    return "/";
  }
}

export function SettingsSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const returnPath = useSyncExternalStore(
    () => () => undefined,
    storedReturnPath,
    () => "/",
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Open sheets and dialogs own Escape; only leave settings when none are up.
      if (document.querySelector("dialog[open]")) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      router.push(storedReturnPath());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <aside
      className={cn(
        "border-[var(--border)]",
        "max-md:sticky max-md:top-0 max-md:z-30 max-md:border-b max-md:bg-[var(--bg)]",
        "md:sticky md:top-0 md:flex md:h-dvh md:w-[240px] md:shrink-0 md:flex-col md:border-r",
      )}
    >
      <div className="px-4 pt-4 max-md:pb-2 md:pb-4">
        <Link
          href={returnPath}
          className="inline-flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] font-medium text-[var(--fg-muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to app
        </Link>
      </div>
      <nav aria-label="Settings sections" className="hide-scrollbar max-md:overflow-x-auto max-md:border-t max-md:border-[var(--border)] max-md:px-4 md:px-4">
        <ul className="flex gap-1 max-md:h-11 max-md:items-center md:flex-col">
          {items.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  prefetch={true}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-[6px] px-3 text-[13px] whitespace-nowrap text-[var(--fg-muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]",
                    active && "bg-[var(--hover)] font-medium text-[var(--fg)]",
                  )}
                >
                  {item.label}
                  <LinkPendingPulse />
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
