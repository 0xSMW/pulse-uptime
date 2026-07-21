"use client"

import { Monitor, Moon, Sun, User } from "lucide-react"
import Link from "next/link"
import { useState } from "react"

import { type Theme, useTheme } from "@/components/dashboard/theme-provider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { initialsFor } from "@/lib/account/initials"
import { cn } from "@/lib/utils"

const themeOptions: { label: string; value: Theme; Icon: typeof Monitor }[] = [
  { label: "System", value: "system", Icon: Monitor },
  { label: "Dark", value: "dark", Icon: Moon },
  { label: "Light", value: "light", Icon: Sun },
]

function MenuAppearanceControl() {
  const { theme, setTheme } = useTheme()

  return (
    <DropdownMenuRadioGroup
      aria-label="Appearance"
      className="flex w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--code-bg)] p-0.5"
      onValueChange={(value) => setTheme(value as Theme)}
      value={theme}
    >
      {themeOptions.map((option) => (
        <DropdownMenuRadioItem
          aria-label={`${option.label} appearance`}
          className={cn(
            "h-7 flex-1 justify-center rounded-[4px] px-0 text-[var(--fg-muted)]",
            "data-[highlighted]:bg-[var(--hover)]",
            "data-[checked]:bg-[var(--bg)] data-[checked]:text-[var(--fg)] data-[checked]:shadow-[0_1px_2px_rgb(0_0_0/16%)]"
          )}
          key={option.value}
          title={option.label}
          value={option.value}
        >
          <option.Icon aria-hidden="true" className="size-4" />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

export function UserMenu({
  email,
  name = null,
  avatarImageId = null,
}: {
  email: string
  name?: string | null
  avatarImageId?: string | null
}) {
  const [signingOut, setSigningOut] = useState(false)
  const displayName = name?.trim() || ""
  // Initials stand in for the avatar only when a name is set. Without one the
  // frame keeps the neutral User glyph rather than an email-derived letter.
  const initials = displayName ? initialsFor(displayName, email) : ""

  async function signOut() {
    if (signingOut) {
      return
    }
    setSigningOut(true)
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" })
      const payload = response.ok
        ? ((await response.json()) as { redirect?: string })
        : {}
      window.location.assign(payload.redirect ?? "/login")
    } catch {
      setSigningOut(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account"
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-[var(--border-strong)] bg-[var(--chip-bg)] font-medium text-[11px] text-[var(--fg)] hover:border-[var(--border-hover)] data-[popup-open]:border-[var(--border-hover)]"
        title="Account"
      >
        {avatarImageId ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated dynamic bytes, not an optimizable static asset
          <img
            alt=""
            className="size-full object-cover"
            height={32}
            src={`/api/v1/images/${avatarImageId}`}
            width={32}
          />
        ) : initials ? (
          initials
        ) : (
          <User aria-hidden="true" className="size-4" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[248px]">
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border-strong)] bg-[var(--chip-bg)] font-medium text-[11px] text-[var(--fg-muted)]"
          >
            {avatarImageId ? (
              // eslint-disable-next-line @next/next/no-img-element -- authenticated dynamic bytes, not an optimizable static asset
              <img
                alt=""
                className="size-full object-cover"
                height={32}
                src={`/api/v1/images/${avatarImageId}`}
                width={32}
              />
            ) : initials ? (
              initials
            ) : (
              <User aria-hidden="true" className="size-4" />
            )}
          </span>
          <span className="flex min-w-0 flex-col">
            {displayName ? (
              <span className="min-w-0 truncate text-[13px] text-[var(--fg)]">
                {displayName}
              </span>
            ) : null}
            <span
              className={cn(
                "min-w-0 truncate text-[13px]",
                displayName ? "text-[var(--fg-muted)]" : "text-[var(--fg)]"
              )}
            >
              {email}
            </span>
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem render={<Link href="/settings/account" />}>
          Settings
        </DropdownMenuLinkItem>
        <DropdownMenuLinkItem render={<Link href="/help" />}>
          Help Center
        </DropdownMenuLinkItem>
        <DropdownMenuSeparator />
        <div className="px-2.5 pt-1.5 pb-2">
          <MenuAppearanceControl />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          closeOnClick={false}
          disabled={signingOut}
          onClick={() => void signOut()}
        >
          {signingOut ? "Signing out…" : "Sign Out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
