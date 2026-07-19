"use client";

import {
  Activity,
  ArrowLeft,
  Bell,
  CircleUser,
  Database,
  KeyRound,
  Palette,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useSettingsDirty } from "@/components/settings/settings-dirty";
import { cn } from "@/lib/utils";

export const SETTINGS_RETURN_KEY = "pulse:settings-return";

type SidebarItem = { href: string; label: string; icon: LucideIcon };
type SidebarSection = { label: string; items: SidebarItem[] };

const sections: SidebarSection[] = [
  {
    label: "Account",
    items: [
      { href: "/settings/account", label: "Account", icon: CircleUser },
      { href: "/settings/security", label: "Security", icon: ShieldCheck },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/settings/status-page", label: "Status page", icon: Palette },
      { href: "/settings/notifications", label: "Notifications", icon: Bell },
      { href: "/settings/monitors", label: "Monitors", icon: Activity },
      { href: "/settings/access", label: "Access", icon: KeyRound },
      { href: "/settings/system", label: "System", icon: Database },
    ],
  },
];

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
  const dirtyContext = useSettingsDirty();
  const dirty = dirtyContext?.dirty ?? false;
  const [escFeedback, setEscFeedback] = useState("");
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
      // A dirty form suppresses the Esc exit entirely; leaving requires the
      // explicit, confirmable Back-to-app or sidebar navigation. Announce why
      // the key did nothing instead of failing silently.
      if (dirty) {
        setEscFeedback("Unsaved changes — save or discard before leaving");
        return;
      }
      router.push(storedReturnPath());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, dirty]);

  // Clear the suppressed-Esc announcement once the forms are clean again
  // (render-time state adjustment; see react.dev "You Might Not Need an Effect").
  const [prevDirty, setPrevDirty] = useState(dirty);
  if (prevDirty !== dirty) {
    setPrevDirty(dirty);
    if (!dirty) setEscFeedback("");
  }

  // Sidebar links carry no dirty-check of their own: navigation confirms are
  // provided globally by SettingsDirtyProvider's guard (a document-wide click
  // listener), which covers these links plus TopNav/logo from one place.

  return (
    <aside
      className={cn(
        "border-[var(--border)]",
        "max-md:sticky max-md:top-0 max-md:z-30 max-md:border-b max-md:bg-[var(--bg)]",
        "md:sticky md:top-0 md:flex md:h-dvh md:w-[240px] md:shrink-0 md:flex-col md:border-r",
      )}
    >
      <p aria-live="polite" className="sr-only">
        {escFeedback}
      </p>
      <div className="px-4 pt-4 max-md:pb-2 md:pb-4">
        <Link
          href={returnPath}
          className="inline-flex h-8 items-center gap-2 rounded-[6px] px-2 text-[13px] font-medium text-[var(--fg-muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to app
        </Link>
      </div>
      <nav
        aria-label="Settings sections"
        className="hide-scrollbar max-md:overflow-x-auto max-md:border-t max-md:border-[var(--border)] max-md:px-4 md:px-4"
      >
        <div className="flex gap-4 max-md:h-11 max-md:items-center md:flex-col">
          {sections.map((section) => (
            <div key={section.label} className="flex gap-1 max-md:items-center md:flex-col">
              <span className="px-3 text-[11px] font-medium tracking-[0.04em] text-[var(--fg-faint)] uppercase max-md:sr-only md:mb-1">
                {section.label}
              </span>
              <ul className="flex gap-1 max-md:items-center md:flex-col">
                {section.items.map((item) => {
                  const active = pathname.startsWith(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex h-8 items-center gap-2 rounded-[6px] px-3 text-[13px] whitespace-nowrap text-[var(--fg-muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]",
                          active && "bg-[var(--hover)] font-medium text-[var(--fg)]",
                        )}
                      >
                        <item.icon className="size-4 shrink-0" aria-hidden />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    </aside>
  );
}
