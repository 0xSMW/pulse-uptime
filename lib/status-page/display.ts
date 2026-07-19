import type { TimelineBucket } from "@/components/monitors/timeline-bar";

import { STATUS_PAGE_NAME_FALLBACK, type StatusPageConfigDocument } from "./schema";

/**
 * Pure display helpers for status page personalization. No server-only
 * marker: these are deterministic functions shared by the public page RSCs and
 * unit tests.
 */

/** Matches the migration seed so a missing config row renders today's page. */
export function defaultStatusPageDocument(
  env: Record<string, string | undefined> = process.env,
): StatusPageConfigDocument {
  return {
    name: env.NEXT_PUBLIC_STATUS_PAGE_NAME?.trim() || STATUS_PAGE_NAME_FALLBACK,
    layout: "vertical",
    theme: "system",
    logoLightImageId: null,
    logoDarkImageId: null,
    faviconImageId: null,
    homepageUrl: null,
    contactUrl: null,
    navLinks: [],
    googleTagId: null,
    customCss: null,
    customHead: null,
    announcementEnabled: false,
    announcementMarkdown: null,
    historyDays: 90,
    uptimeDecimals: 2,
    unknownAsOperational: false,
    minIncidentSeconds: 0,
    timezone: null,
  };
}

export type TimezoneDisplay = {
  /** IANA zone safe to hand to Intl (falls back to UTC on bad input). */
  timeZone: string;
  /** Per-timestamp suffix, e.g. "UTC" or "GMT+7". */
  short: string;
  /** Page-level label, e.g. "UTC" or "GMT+7 · Asia/Bangkok". */
  full: string;
};

/** Default (null) is UTC, labeled exactly as the page always labeled it. */
export function timezoneDisplay(timezone: string | null, at: Date = new Date()): TimezoneDisplay {
  if (!timezone || timezone === "UTC") return { timeZone: "UTC", short: "UTC", full: "UTC" };
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    }).formatToParts(at);
    const offset = parts.find((part) => part.type === "timeZoneName")?.value ?? timezone;
    return { timeZone: timezone, short: offset, full: `${offset} · ${timezone}` };
  } catch {
    return { timeZone: "UTC", short: "UTC", full: "UTC" };
  }
}

/**
 * Per-timestamp offset suffix. A page-level TimezoneDisplay computed once
 * (e.g. at lastUpdatedAt) and reused for every rendered row gives rows on the
 * other side of a DST boundary the correct wall-clock time but the WRONG
 * offset label, so callers rendering a specific row's own instant must call
 * this instead of reusing a single page-level `.short`. UTC (the default)
 * never observes DST, so its behavior is unchanged either way.
 */
export function timezoneOffsetLabel(timezone: string | null, at: Date): string {
  return timezoneDisplay(timezone, at).short;
}

export function formatStatusTimestamp(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
}

export function formatStatusClock(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  });
}

/** Uptime percentage honoring the configured decimal places (0-3). */
export function formatUptimePercent(value: number | null, decimals: number): string {
  if (value === null) return "—";
  const places = Math.min(3, Math.max(0, Math.trunc(decimals)));
  return `${value.toFixed(places)}%`;
}

/**
 * Hides resolved blips shorter than the configured floor from the incident
 * history list. Ongoing incidents and timelines are never filtered.
 */
export function filterShortResolvedIncidents<T extends { durationSeconds: number }>(
  incidents: readonly T[],
  minIncidentSeconds: number,
): T[] {
  if (minIncidentSeconds <= 0) return [...incidents];
  return incidents.filter((incident) => incident.durationSeconds >= minIncidentSeconds);
}

/** Unknown/not-yet-monitored buckets render as operational when configured. */
export function displayTimelineBuckets(
  buckets: readonly TimelineBucket[],
  unknownAsOperational: boolean,
): TimelineBucket[] {
  if (!unknownAsOperational) return [...buckets];
  return buckets.map((bucket) =>
    bucket.state === "no-data" ? { ...bucket, state: "up" as const } : bucket,
  );
}

/** Start of the rollup fetch window: `historyDays` before the completed day. */
export function historyWindowStart(historyDays: number, completedDay: Date): Date {
  return new Date(completedDay.getTime() - historyDays * 86_400_000);
}

/** data: URI for the ISR'd favicon. The asset never becomes a request. */
export function imageDataUri(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Public serving route for logo image ids (kind-restricted server-side). */
export function statusAssetUrl(imageId: string): string {
  return `/status/assets/${imageId}`;
}
