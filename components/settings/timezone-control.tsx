"use client"

import { useState } from "react"

import { useTimezone } from "@/components/dashboard/timezone-provider"
import {
  type Message,
  StatusMessage,
} from "@/components/settings/status-message"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

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
]

function optionsIncluding(value: string) {
  return timezoneOptions.some((zone) => zone.value === value)
    ? timezoneOptions
    : [...timezoneOptions, { label: value, value }]
}

/**
 * The account time zone control: the single writer. Committing a value here
 * saves it to the account and clears any this-device override. A separate,
 * explicitly labeled affordance creates a device override.
 */
export function TimezoneControl() {
  const {
    resolvedTimeZone,
    serverTimezone,
    deviceOverride,
    setServerTimezone,
    setDeviceOverride,
  } = useTimezone()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Message | null>(null)
  const [overrideOpen, setOverrideOpen] = useState(false)

  const accountValue = serverTimezone ?? "system"

  async function commitAccountTimezone(value: string) {
    setBusy(true)
    setStatus(null)
    try {
      const response = await fetch("/api/v1/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: value === "system" ? null : value }),
      })
      if (!response.ok) {
        throw new Error("Request failed")
      }
      setServerTimezone(value === "system" ? null : value)
      setStatus({ text: "Account time zone saved", tone: "info" })
    } catch {
      setStatus({
        text: "Could not save the account time zone. Try again.",
        tone: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Select
        disabled={busy}
        onValueChange={(value) => void commitAccountTimezone(value)}
        value={accountValue}
      >
        <SelectTrigger aria-label="Account time zone" className="w-[280px]">
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
      <p className="mt-3 text-[var(--fg-faint)] text-xs">
        {deviceOverride ? (
          <>
            Overridden on this device ·{" "}
            <span className="font-data">{deviceOverride}</span>
            {" — "}
            <button
              className="text-[var(--fg-muted)] underline underline-offset-2 hover:text-[var(--fg)]"
              onClick={() => {
                setDeviceOverride(null)
                setOverrideOpen(false)
                setStatus({ text: "Device override removed", tone: "info" })
              }}
              type="button"
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
      {deviceOverride ? null : overrideOpen ? (
        <div className="mt-3">
          <Select
            onValueChange={(value) => {
              setDeviceOverride(value)
              setOverrideOpen(false)
              setStatus({
                text: "This device now uses its own time zone",
                tone: "info",
              })
            }}
            value=""
          >
            <SelectTrigger
              aria-label="Device time zone override"
              className="w-[280px]"
            >
              <SelectValue placeholder="Choose a time zone for this device" />
            </SelectTrigger>
            <SelectContent>
              {timezoneOptions
                .filter((zone) => zone.value !== "system")
                .map((zone) => (
                  <SelectItem key={zone.value} value={zone.value}>
                    {zone.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-[var(--fg-faint)] text-xs">
            Only this browser is affected; the account value stays unchanged.
          </p>
        </div>
      ) : (
        <button
          className="mt-2 text-[var(--fg-muted)] text-xs underline underline-offset-2 hover:text-[var(--fg)]"
          onClick={() => setOverrideOpen(true)}
          type="button"
        >
          Use a different time zone on this device
        </button>
      )}
      {/* The one always-mounted live region for this control. */}
      <StatusMessage className="mt-1 min-h-4 text-xs" message={status} />
    </div>
  )
}
