"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

export const MIN_REFRESH_GAP_MS = 10_000;

export function shouldAutoRefresh(
  visibilityState: DocumentVisibilityState,
  now: number,
  lastRefreshAt: number,
): boolean {
  return visibilityState === "visible" && now - lastRefreshAt >= MIN_REFRESH_GAP_MS;
}

// Server data changes outside browser mutations (cron writes monitor state
// every minute), so the 30s router cache needs a freshness backstop: refresh
// on window focus, and optionally on an interval while the tab is visible.
//
// Known, accepted cost: each refresh invalidates the segment cache, which
// re-triggers prefetches for visible prefetch={true} links (3-4 bounded nav
// links). For this single-operator dashboard that is a handful of cheap
// in-region renders per minute, and only while the tab is visible — the price
// of always-fresh, instantly-navigable tabs.
export function AutoRefresh({ intervalMs }: { intervalMs?: number }) {
  const router = useRouter();
  const lastRefreshAtRef = useRef(Date.now());

  useEffect(() => {
    const refresh = () => {
      if (!shouldAutoRefresh(document.visibilityState, Date.now(), lastRefreshAtRef.current)) return;
      lastRefreshAtRef.current = Date.now();
      router.refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = intervalMs ? window.setInterval(refresh, intervalMs) : undefined;
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      if (timer) window.clearInterval(timer);
    };
  }, [router, intervalMs]);

  return null;
}
