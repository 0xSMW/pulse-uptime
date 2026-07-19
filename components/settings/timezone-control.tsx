"use client";

import { useState } from "react";

import { useTimezone } from "@/components/dashboard/timezone-provider";
import { StatusMessage, type Message } from "@/components/settings/status-message";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const timezoneOptions: { label: string; value: string }[] = [
  { label: "System", value: "system" },
  { label: "UTC", value: "UTC" },
  { label: "Bangkok (UTC+7)", value: "Asia/Bangkok" },
  { label: "Singapore (UTC+8)", value: "Asia/Singapore" },
  { label: "Tokyo (UTC+9)", value: "Asia/Tokyo" },
  { label: "London", value: "Europe/London" },
  { label: "Berlin", value: "Europe/Berlin" },
  { label: "New York", value: "America/New_York" },
  { label: "Chicago", value: "America/Chicago" },
  { label: "Los Angeles", value: "America/Los_Angeles" },
  { label: "Sydney", value: "Australia/Sydney" },
];

function optionsIncluding(value: string) {
  return timezoneOptions.some((zone) => zone.value === value)
    ? timezoneOptions
    : [...timezoneOptions, { label: value, value }];
}

/**
 * The account time zone control: the single writer. Committing a value here
 * saves it to the account and clears any this-device override. A separate,
 * explicitly labeled affordance creates a device override.
 */
export function TimezoneControl() {
  const { resolvedTimeZone, serverTimezone, deviceOverride, setServerTimezone, setDeviceOverride } = useTimezone();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Message | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);

  const accountValue = serverTimezone ?? "system";

  async function commitAccountTimezone(value: string) {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/v1/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: value === "system" ? null : value }),
      });
      if (!response.ok) throw new Error("Request failed");
      setServerTimezone(value === "system" ? null : value);
      setStatus({ text: "Account time zone saved", tone: "info" });
    } catch {
      setStatus({ text: "Could not save the account time zone. Try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Select value={accountValue} onValueChange={(value) => void commitAccountTimezone(value)} disabled={busy}>
        <SelectTrigger className="w-[280px]" aria-label="Account time zone">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {optionsIncluding(accountValue).map((zone) => (
            <SelectItem key={zone.value} value={zone.value}>
              {zone.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="mt-3 text-xs text-[var(--fg-faint)]">
        {deviceOverride ? (
          <>
            Overridden on this device ·{" "}
            <span className="font-data">{deviceOverride}</span>
            {" — "}
            <button
              type="button"
              className="text-[var(--fg-muted)] underline underline-offset-2 hover:text-[var(--fg)]"
              onClick={() => {
                setDeviceOverride(null);
                setOverrideOpen(false);
                setStatus({ text: "Device override removed", tone: "info" });
              }}
            >
              Reset
            </button>
          </>
        ) : accountValue === "system" ? (
          `Following your device · ${resolvedTimeZone}`
        ) : (
          `Timestamps display in ${resolvedTimeZone}`
        )}
      </p>
      {!deviceOverride ? (
        overrideOpen ? (
          <div className="mt-3">
            <Select
              value=""
              onValueChange={(value) => {
                setDeviceOverride(value);
                setOverrideOpen(false);
                setStatus({ text: "This device now uses its own time zone", tone: "info" });
              }}
            >
              <SelectTrigger className="w-[280px]" aria-label="Device time zone override">
                <SelectValue placeholder="Choose a time zone for this device" />
              </SelectTrigger>
              <SelectContent>
                {timezoneOptions.filter((zone) => zone.value !== "system").map((zone) => (
                  <SelectItem key={zone.value} value={zone.value}>
                    {zone.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-[var(--fg-faint)]">Only this browser is affected; the account value stays unchanged.</p>
          </div>
        ) : (
          <button
            type="button"
            className="mt-2 text-xs text-[var(--fg-muted)] underline underline-offset-2 hover:text-[var(--fg)]"
            onClick={() => setOverrideOpen(true)}
          >
            Use a different time zone on this device
          </button>
        )
      ) : null}
      {/* The one always-mounted live region for this control. */}
      <StatusMessage message={status} className="mt-1 min-h-4 text-xs" />
    </div>
  );
}
