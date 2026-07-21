"use client"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef } from "react"

export const MIN_REFRESH_GAP_MS = 10_000

export function shouldAutoRefresh(
  visibilityState: DocumentVisibilityState,
  now: number,
  lastRefreshAt: number
): boolean {
  return (
    visibilityState === "visible" && now - lastRefreshAt >= MIN_REFRESH_GAP_MS
  )
}

// The monitor detail page runs its own targeted live poll, so the blanket
// refresh stands down there to avoid refetching the tree twice.
export function isLiveManagedPath(pathname: string): boolean {
  return /^\/monitors\/[^/]+$/.test(pathname)
}

// Cron writes monitor state every minute outside browser mutations, so the
// 30s router cache needs a freshness backstop: refresh on focus, plus an
// optional interval while visible. Each refresh also re-triggers prefetch
// for the always-visible full-prefetch nav links, a few cheap in-region renders.
export function AutoRefresh({ intervalMs }: { intervalMs?: number }) {
  const router = useRouter()
  const pathname = usePathname()
  const lastRefreshAtRef = useRef(0)

  useEffect(() => {
    // The detail page's live poll owns freshness there, so this backstop skips
    // it entirely and never fights the poll.
    if (isLiveManagedPath(pathname)) {
      return
    }
    // Seed here, not during render (render must stay pure), so a focus or
    // visibilitychange event firing right after mount skips a redundant refresh.
    lastRefreshAtRef.current = Date.now()

    const refresh = () => {
      if (
        !shouldAutoRefresh(
          document.visibilityState,
          Date.now(),
          lastRefreshAtRef.current
        )
      ) {
        return
      }
      lastRefreshAtRef.current = Date.now()
      router.refresh()
    }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    const timer = intervalMs
      ? window.setInterval(refresh, intervalMs)
      : undefined
    return () => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
      if (timer) {
        window.clearInterval(timer)
      }
    }
  }, [router, intervalMs, pathname])

  return null
}
