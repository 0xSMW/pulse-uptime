"use client";

import Link from "next/link";
import * as React from "react";

export const DISCARD_PROMPT = "Discard unsaved changes?";

type SettingsDirtyContextValue = {
  dirty: boolean;
  markDirty: (key: string, dirty: boolean) => void;
};

const SettingsDirtyContext = React.createContext<SettingsDirtyContextValue | null>(null);

/**
 * Settings-shell dirty state. Any dirty form suppresses the Esc exit and makes
 * "Back to app" and sidebar navigation confirm before discarding.
 */
export function SettingsDirtyProvider({ children }: { children: React.ReactNode }) {
  const [dirtyKeys, setDirtyKeys] = React.useState<ReadonlySet<string>>(() => new Set());

  const markDirty = React.useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((current) => {
      if (current.has(key) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const dirty = dirtyKeys.size > 0;

  // Hard navigations (reload, close tab, external links) bypass client-side
  // routing entirely, so the browser's native prompt is the only guard.
  React.useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const value = React.useMemo(
    () => ({ dirty, markDirty }),
    [dirty, markDirty],
  );

  return <SettingsDirtyContext.Provider value={value}>{children}</SettingsDirtyContext.Provider>;
}

/** Null outside the settings shell so shared components stay reusable. */
export function useSettingsDirty(): SettingsDirtyContextValue | null {
  return React.useContext(SettingsDirtyContext);
}

/**
 * A link that consults the settings dirty state and confirms before
 * navigating away from unsaved changes. Renders a plain next/link outside
 * the settings shell.
 */
export function GuardedLink({
  onClick,
  ...props
}: React.ComponentProps<typeof Link>) {
  const context = useSettingsDirty();
  const dirty = context?.dirty ?? false;
  return (
    <Link
      {...props}
      onClick={(event) => {
        if (dirty && !window.confirm(DISCARD_PROMPT)) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    />
  );
}

/** Registers a form's dirty state with the settings shell while mounted. */
export function useDirtyGuard(key: string, isDirty: boolean) {
  const context = useSettingsDirty();
  const markDirty = context?.markDirty;
  React.useEffect(() => {
    if (!markDirty) return;
    markDirty(key, isDirty);
    return () => markDirty(key, false);
  }, [markDirty, key, isDirty]);
}
