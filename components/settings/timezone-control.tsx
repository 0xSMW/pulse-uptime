"use client";

import { useTimezone } from "@/components/dashboard/timezone-provider";
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

export function TimezoneControl() {
  const { timezone, resolvedTimeZone, setTimezone } = useTimezone();
  const options = timezoneOptions.some((zone) => zone.value === timezone)
    ? timezoneOptions
    : [...timezoneOptions, { label: timezone, value: timezone }];

  return (
    <div>
      <Select value={timezone} onValueChange={setTimezone}>
        <SelectTrigger className="w-[280px]" aria-label="Time zone">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((zone) => (
            <SelectItem key={zone.value} value={zone.value}>
              {zone.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="mt-3 text-xs text-[var(--fg-faint)]" aria-live="polite">
        {timezone === "system"
          ? `Following your device · ${resolvedTimeZone}`
          : `Timestamps display in ${resolvedTimeZone}`}
      </p>
    </div>
  );
}
