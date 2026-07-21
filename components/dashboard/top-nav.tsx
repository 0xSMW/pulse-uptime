"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { UserMenu } from "@/components/dashboard/user-menu";
import { LinkPendingPulse } from "@/components/ui/link-status";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Overview", match: (path: string) => path === "/" || path.startsWith("/monitors/") },
  { href: "/incidents", label: "Incidents", match: (path: string) => path.startsWith("/incidents") },
  { href: "/status", label: "Status Page", match: () => false, external: true },
] as const;

export function TopNav({
  email,
  name = null,
  avatarImageId = null,
}: {
  email: string;
  name?: string | null;
  avatarImageId?: string | null;
}) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 bg-[color:var(--bg)]/95 backdrop-blur">
      <nav
        aria-label="Primary navigation"
        className="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-6 lg:px-8"
      >
        <Link href="/" className="mr-2 flex items-center gap-2 font-semibold">
          <span className="size-2 rounded-full bg-[var(--fg)]" aria-hidden="true" />
          Pulse
        </Link>
        <div className="flex h-full min-w-0 items-center gap-5 overflow-x-auto">
          {links.map((link) => {
            const active = link.match(pathname);
            return (
              <Link
                key={link.href}
                href={link.href}
                prefetch={"external" in link && link.external ? undefined : true}
                target={"external" in link && link.external ? "_blank" : undefined}
                rel={"external" in link && link.external ? "noreferrer" : undefined}
                className={cn(
                  "relative flex h-full items-center gap-1 whitespace-nowrap text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]",
                  active && "text-[var(--fg)] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[var(--fg)]",
                )}
                aria-current={active ? "page" : undefined}
              >
                {link.label}
                {"external" in link && link.external ? <ArrowUpRight className="size-3" aria-hidden="true" /> : null}
                <LinkPendingPulse className="-right-2.5" />
              </Link>
            );
          })}
        </div>
        <div className="ml-auto flex items-center">
          <UserMenu email={email} name={name} avatarImageId={avatarImageId} />
        </div>
      </nav>
    </header>
  );
}
