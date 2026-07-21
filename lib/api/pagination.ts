import { Buffer } from "node:buffer"

import { isUuid } from "@/lib/ids/uuid"

export interface CursorValue {
  sort: string
  id: string
}

/** Timestamp + UUID keyset cursor used by tokens, incidents, and status reports. */
export interface TimestampUuidCursor {
  sort: Date
  id: string
}

/**
 * Result of decoding a timestamp+UUID cursor.
 * `cursor: null` means the param was absent. `ok: false` means present but invalid.
 */
export type TimestampUuidCursorResult =
  | { ok: true; cursor: TimestampUuidCursor | null }
  | { ok: false }

// Matches Date.prototype.toISOString() so encoders and decoders share one shape.
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

/**
 * Low-level opaque cursor decoder. Checks only that sort and id are strings.
 * Prefer decodeTimestampUuidCursor for timestamp+UUID keyset pages.
 */
export function decodeCursor(value: string | null): CursorValue | null {
  if (!value) {
    return null
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    const cursor = parsed as Partial<CursorValue>
    return typeof cursor.sort === "string" && typeof cursor.id === "string"
      ? { sort: cursor.sort, id: cursor.id }
      : null
  } catch {
    return null
  }
}

/**
 * Decode a keyset cursor whose sort is an ISO-8601 UTC timestamp and id is a UUID.
 * Rejects invalid base64url, JSON, shape, timestamps, and non-UUID ids before any DB use.
 */
export function decodeTimestampUuidCursor(
  value: string | null
): TimestampUuidCursorResult {
  if (value === null) {
    return { ok: true, cursor: null }
  }
  // Present but empty (e.g. ?cursor=) is invalid, not absent.
  if (value === "") {
    return { ok: false }
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false }
    }
    const record = parsed as Record<string, unknown>
    if (typeof record.sort !== "string" || typeof record.id !== "string") {
      return { ok: false }
    }
    if (!isUuid(record.id)) {
      return { ok: false }
    }
    const sort = parseCursorTimestamp(record.sort)
    if (!sort) {
      return { ok: false }
    }
    return { ok: true, cursor: { sort, id: record.id } }
  } catch {
    return { ok: false }
  }
}

function parseCursorTimestamp(value: string): Date | null {
  if (!CURSOR_TIMESTAMP_PATTERN.test(value)) {
    return null
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  // Reject calendar overflow (e.g. 2026-02-30) that Date rolls to another day.
  if (date.toISOString() !== value) {
    return null
  }
  return date
}

export function pageLimit(value: string | null, fallback = 50): number | null {
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : null
}
