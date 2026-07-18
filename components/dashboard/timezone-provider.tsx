"use client";

import * as React from "react";

export const DEFAULT_TIMEZONE = "system";
/**
 * Deliberate this-device overrides only. The legacy "pulse-timezone" key was
 * written on every pick, so a concrete value there does NOT represent a
 * deliberate override — promoting it would permanently mask the account
 * time zone. It is deleted on load, never adopted.
 */
export const TIMEZONE_STORAGE_KEY = "pulse-timezone-override";
export const LEGACY_TIMEZONE_STORAGE_KEY = "pulse-timezone";

export type TimezonePreference = "system" | string;

interface TimezoneContextValue {
  /** Effective preference: device override → account (server) → system. */
  timezone: TimezonePreference;
  resolvedTimeZone: string;
  /** The account-level value (null = follow system). */
  serverTimezone: string | null;
  /** The deliberate this-device override (null = none). */
  deviceOverride: string | null;
  /** Account commit: adopts the server value and clears the device override key. */
  setServerTimezone: (timezone: string | null) => void;
  /** Hydration sync from the server; never touches the device override. */
  adoptServerTimezone: (timezone: string | null) => void;
  /** Creates or clears the explicit this-device override. */
  setDeviceOverride: (timezone: string | null) => void;
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
  storageKey = TIMEZONE_STORAGE_KEY,
}: TimezoneProviderProps) {
  const [deviceOverride, setDeviceOverrideState] = React.useState<string | null>(null);
  const [serverTimezone, setServerTimezoneState] = React.useState<string | null>(null);

  React.useEffect(() => {
    // The legacy key was written on every pick, deliberate or not; a concrete
    // value there is not evidence of a deliberate override. Drop it outright.
    window.localStorage.removeItem(LEGACY_TIMEZONE_STORAGE_KEY);
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return;
    if (saved === "system" || !isValidTimeZone(saved)) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    queueMicrotask(() => setDeviceOverrideState(saved));
  }, [storageKey]);

  const setDeviceOverride = React.useCallback(
    (nextTimezone: string | null) => {
      if (nextTimezone === null || nextTimezone === "system" || !isValidTimeZone(nextTimezone)) {
        window.localStorage.removeItem(storageKey);
        setDeviceOverrideState(null);
        return;
      }
      window.localStorage.setItem(storageKey, nextTimezone);
      setDeviceOverrideState(nextTimezone);
    },
    [storageKey],
  );

  // The account control is the single writer: committing a server value always
  // clears the device key so this device follows the account again.
  const setServerTimezone = React.useCallback(
    (nextTimezone: string | null) => {
      window.localStorage.removeItem(storageKey);
      setDeviceOverrideState(null);
      setServerTimezoneState(nextTimezone && isValidTimeZone(nextTimezone) && nextTimezone !== "system" ? nextTimezone : null);
    },
    [storageKey],
  );

  const adoptServerTimezone = React.useCallback((nextTimezone: string | null) => {
    setServerTimezoneState((current) => {
      const next = nextTimezone && isValidTimeZone(nextTimezone) && nextTimezone !== "system" ? nextTimezone : null;
      return current === next ? current : next;
    });
  }, []);

  // Server snapshot stays UTC so SSR output is deterministic; React swaps in
  // the device zone right after hydration.
  const systemTimeZone = React.useSyncExternalStore(
    subscribeToSystemTimeZone,
    getSystemTimeZone,
    () => "UTC",
  );
  const timezone = deviceOverride ?? serverTimezone ?? defaultTimezone;
  const resolvedTimeZone = timezone === "system" ? systemTimeZone : timezone;

  const value = React.useMemo(
    () => ({
      timezone,
      resolvedTimeZone,
      serverTimezone,
      deviceOverride,
      setServerTimezone,
      adoptServerTimezone,
      setDeviceOverride,
    }),
    [timezone, resolvedTimeZone, serverTimezone, deviceOverride, setServerTimezone, adoptServerTimezone, setDeviceOverride],
  );

  return <TimezoneContext.Provider value={value}>{children}</TimezoneContext.Provider>;
}

function useTimezone() {
  const context = React.useContext(TimezoneContext);
  if (!context) throw new Error("useTimezone must be used within TimezoneProvider");
  return context;
}

/**
 * Rendered by authenticated layouts to hydrate the provider with the
 * account-level time zone without making the root layout dynamic.
 */
function TimezoneServerSync({ timezone }: { timezone: string | null }) {
  const { adoptServerTimezone } = useTimezone();
  React.useEffect(() => {
    adoptServerTimezone(timezone);
  }, [adoptServerTimezone, timezone]);
  return null;
}

export { TimezoneProvider, TimezoneServerSync, useTimezone };
