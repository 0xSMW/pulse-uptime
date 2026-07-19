"use client";

import { CircleUser, Monitor, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { useTheme, type Theme } from "@/components/dashboard/theme-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const themeOptions: { label: string; value: Theme; Icon: typeof Monitor }[] = [
  { label: "System", value: "system", Icon: Monitor },
  { label: "Dark", value: "dark", Icon: Moon },
  { label: "Light", value: "light", Icon: Sun },
];

export function MenuAppearanceControl() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenuRadioGroup
      value={theme}
      onValueChange={(value) => setTheme(value as Theme)}
      aria-label="Appearance"
      className="flex w-full rounded-[6px] border border-[var(--border-strong)] bg-[var(--code-bg)] p-0.5"
    >
      {themeOptions.map((option) => (
        <DropdownMenuRadioItem
          key={option.value}
          value={option.value}
          aria-label={`${option.label} appearance`}
          title={option.label}
          className={cn(
            "h-7 flex-1 justify-center rounded-[4px] px-0 text-[var(--fg-muted)]",
            "data-[highlighted]:bg-[var(--hover)]",
            "data-[checked]:bg-[var(--bg)] data-[checked]:text-[var(--fg)] data-[checked]:shadow-[0_1px_2px_rgb(0_0_0/16%)]",
          )}
        >
          <option.Icon className="size-4" aria-hidden="true" />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

export function UserMenu({ email }: { email: string }) {
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      const payload = response.ok ? ((await response.json()) as { redirect?: string }) : {};
      window.location.assign(payload.redirect ?? "/login");
    } catch {
      setSigningOut(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Account"
        aria-label="Account"
        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--chip-bg)] text-[var(--fg)] hover:border-[var(--border-hover)] data-[popup-open]:border-[var(--border-hover)]"
      >
        <CircleUser className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[248px]">
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <CircleUser className="size-4 shrink-0 text-[var(--fg-muted)]" aria-hidden="true" />
          <span className="min-w-0 truncate text-[13px] text-[var(--fg)]">{email}</span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem render={<Link href="/settings/account" />}>Settings</DropdownMenuLinkItem>
        <DropdownMenuLinkItem render={<Link href="/help" />}>Help Center</DropdownMenuLinkItem>
        <DropdownMenuSeparator />
        <div className="px-2.5 pt-1.5 pb-2">
          <MenuAppearanceControl />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()} closeOnClick={false} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Sign Out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
