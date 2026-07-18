"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { SETTINGS_RETURN_KEY } from "@/components/settings/settings-sidebar";

/** Records the last in-app page so Settings' "Back to app" can return there. */
export function SettingsReturnTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname.startsWith("/settings")) return;
    try {
      window.sessionStorage.setItem(SETTINGS_RETURN_KEY, pathname);
    } catch {
      // Storage unavailable; Back to app falls back to the overview.
    }
  }, [pathname]);

  return null;
}
