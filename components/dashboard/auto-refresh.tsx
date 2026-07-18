"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const MIN_REFRESH_GAP_MS = 10_000;

// Server data changes outside browser mutations (cron writes monitor state
// every minute), so the 30s router cache needs a freshness backstop: refresh
// on window focus, and optionally on an interval while the tab is visible.
export function AutoRefresh({ intervalMs }: { intervalMs?: number }) {
  const router = useRouter();
  const lastRefreshAtRef = useRef(Date.now());

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefreshAtRef.current < MIN_REFRESH_GAP_MS) return;
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
