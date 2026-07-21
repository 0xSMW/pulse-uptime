"use client"

import {
  Activity,
  ArrowLeft,
  Bell,
  CircleUser,
  Database,
  KeyRound,
  type LucideIcon,
  Palette,
  ShieldCheck,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState, useSyncExternalStore } from "react"

import { useSettingsDirty } from "@/components/settings/settings-dirty"
import { LinkPendingPulse } from "@/components/ui/link-status"
import { cn } from "@/lib/utils"

export const SETTINGS_RETURN_KEY = "pulse:settings-return"

interface SidebarItem {
  href: string
  label: string
  icon: LucideIcon
}
interface SidebarSection {
  label: string
  items: SidebarItem[]
}

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
]

function storedReturnPath(): string {
  try {
    const stored = window.sessionStorage.getItem(SETTINGS_RETURN_KEY)
    return stored?.startsWith("/") && !stored.startsWith("/settings")
      ? stored
      : "/"
  } catch {
    return "/"
  }
}

export function SettingsSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const dirtyContext = useSettingsDirty()
  const dirty = dirtyContext?.dirty ?? false
  const [escFeedback, setEscFeedback] = useState("")
  const returnPath = useSyncExternalStore(
    () => () => undefined,
    storedReturnPath,
    () => "/"
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return
      }
      // Open sheets and dialogs own Escape; only leave settings when none are up.
      if (document.querySelector("dialog[open]")) {
        return
      }
      const target = event.target as HTMLElement | null
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return
      }
      // A dirty form suppresses the Esc exit entirely. Leaving requires the
      // explicit, confirmable Back-to-app or sidebar navigation. Announce why
      // the key did nothing instead of failing silently.
      if (dirty) {
        setEscFeedback("Unsaved changes — save or discard before leaving")
        return
      }
      router.push(storedReturnPath())
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [router, dirty])

  // Clear the suppressed-Esc announcement once the forms are clean again
  // (render-time state adjustment, see react.dev "You Might Not Need an Effect").
  const [prevDirty, setPrevDirty] = useState(dirty)
  if (prevDirty !== dirty) {
    setPrevDirty(dirty)
    if (!dirty) {
      setEscFeedback("")
    }
  }

  // Sidebar links carry no dirty-check of their own: navigation confirms are
  // provided globally by SettingsDirtyProvider's guard (a document-wide click
  // listener), which covers these links plus TopNav/logo from one place.

  return (
    <aside
      className={cn(
        "border-[var(--border)]",
        "max-md:sticky max-md:top-0 max-md:z-30 max-md:border-b max-md:bg-[var(--bg)]",
        "md:sticky md:top-0 md:flex md:h-dvh md:w-[240px] md:shrink-0 md:flex-col md:border-r"
      )}
    >
      <p aria-live="polite" className="sr-only">
        {escFeedback}
      </p>
      <div className="px-4 pt-4 max-md:pb-2 md:pb-4">
        <Link
          className="inline-flex h-8 items-center gap-2 rounded-[6px] px-2 font-medium text-[13px] text-[var(--fg-muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          href={returnPath}
        >
          <ArrowLeft aria-hidden className="size-4" />
          Back to app
        </Link>
      </div>
      <nav
        aria-label="Settings sections"
        className="hide-scrollbar max-md:overflow-x-auto max-md:border-[var(--border)] max-md:border-t max-md:px-4 md:px-4"
      >
        <div className="flex gap-4 max-md:h-11 max-md:items-center md:flex-col">
          {sections.map((section) => (
            <div
              className="flex gap-1 max-md:items-center md:flex-col"
              key={section.label}
            >
              <span className="px-3 font-medium text-[11px] text-[var(--fg-faint)] uppercase tracking-[0.04em] max-md:sr-only md:mb-1">
                {section.label}
              </span>
              <ul className="flex gap-1 max-md:items-center md:flex-col">
                {section.items.map((item) => {
                  const active = pathname.startsWith(item.href)
                  return (
                    <li key={item.href}>
                      <Link
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "relative flex h-8 items-center gap-2 whitespace-nowrap rounded-[6px] px-3 pr-6 text-[13px] text-[var(--fg-muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]",
                          active &&
                            "bg-[var(--hover)] font-medium text-[var(--fg)]"
                        )}
                        href={item.href}
                        prefetch={true}
                      >
                        <item.icon aria-hidden className="size-4 shrink-0" />
                        {item.label}
                        <LinkPendingPulse className="right-2.5" />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    </aside>
  )
}
