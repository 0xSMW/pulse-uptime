"use client";

import * as React from "react";

export const DEFAULT_TIMEZONE = "system";

export type TimezonePreference = "system" | string;

interface TimezoneContextValue {
  timezone: TimezonePreference;
  resolvedTimeZone: string;
  setTimezone: (timezone: TimezonePreference) => void;
}

export interface TimezoneProviderProps {
  children: React.ReactNode;
  defaultTimezone?: string;
  storageKey?: string;
}

const TimezoneContext = React.createContext<TimezoneContextValue | undefined>(undefined);

export function isValidTimeZone(value: string): boolean {
  if (value === "system") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function getSystemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function subscribeToSystemTimeZone() {
  return () => {};
}

function TimezoneProvider({
  children,
  defaultTimezone = DEFAULT_TIMEZONE,
  storageKey = "pulse-timezone",
}: TimezoneProviderProps) {
  const [timezone, setTimezoneState] = React.useState<TimezonePreference>(defaultTimezone);

  React.useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (saved && isValidTimeZone(saved)) {
      queueMicrotask(() => setTimezoneState(saved));
    }
  }, [storageKey]);

  const setTimezone = React.useCallback(
    (nextTimezone: TimezonePreference) => {
      const supported = isValidTimeZone(nextTimezone) ? nextTimezone : defaultTimezone;
      window.localStorage.setItem(storageKey, supported);
      setTimezoneState(supported);
    },
    [defaultTimezone, storageKey],
  );

  // Server snapshot stays UTC so SSR output is deterministic; React swaps in
  // the device zone right after hydration.
  const systemTimeZone = React.useSyncExternalStore(
    subscribeToSystemTimeZone,
    getSystemTimeZone,
    () => "UTC",
  );
  const resolvedTimeZone = timezone === "system" ? systemTimeZone : timezone;

  const value = React.useMemo(
    () => ({ timezone, resolvedTimeZone, setTimezone }),
    [resolvedTimeZone, setTimezone, timezone],
  );

  return <TimezoneContext.Provider value={value}>{children}</TimezoneContext.Provider>;
}

function useTimezone() {
  const context = React.useContext(TimezoneContext);
  if (!context) throw new Error("useTimezone must be used within TimezoneProvider");
  return context;
}

export { TimezoneProvider, useTimezone };
