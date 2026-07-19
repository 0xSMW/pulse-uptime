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

// Cron writes monitor state every minute outside browser mutations, so the
// 30s router cache needs a freshness backstop: refresh on focus, plus an
// optional interval while visible. Each refresh also re-triggers prefetch
// for the always-visible full-prefetch nav links, a few cheap in-region renders.
export function AutoRefresh({ intervalMs }: { intervalMs?: number }) {
  const router = useRouter();
  const lastRefreshAtRef = useRef(0);

  useEffect(() => {
    // Seed here, not during render (render must stay pure), so a focus or
    // visibilitychange event firing right after mount skips a redundant refresh.
    lastRefreshAtRef.current = Date.now();

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
