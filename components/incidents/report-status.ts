import type { VisibleMonitorState } from "@/components/monitors/status-dot"
import {
  impactOptions,
  isResolvingStatus,
  REPORT_STATUS_LABELS,
  REPORT_STATUSES,
  type ReportImpact,
  type ReportType,
  type ReportUpdateStatus,
} from "@/lib/status-reports/domain"
import {
  formatDatetimeInput,
  parseDatetimeInput,
} from "@/lib/time/datetime-input"

/**
 * Client-safe status-report form types and helpers. The DTO shapes mirror the
 * JSON serialization of lib/api/status-reports (StatusReportData). The shared
 * vocabulary (types, status lists, labels, impact options, resolving test)
 * comes from lib/status-reports/domain, re-exported here so client consumers
 * keep one import surface.
 */

export type { ReportImpact, ReportType, ReportUpdateStatus }
export { impactOptions, REPORT_STATUS_LABELS, REPORT_STATUSES }

export interface ReportUpdateData {
  id: string
  status: ReportUpdateStatus
  markdown: string
  publishedAt: string
  /**
   * RFC3339 creation time. Newer serializations include it. When absent the
   * client falls back to array order for the (createdAt, id) tiebreak.
   */
  createdAt?: string
}

interface ReportAffectedData {
  monitorId: string
  monitorName: string
  groupName: string | null
  impact: ReportImpact
}

export interface ReportData {
  id: string
  type: ReportType
  title: string
  startsAt: string
  endsAt: string | null
  publishedAt: string | null
  resolvedAt: string | null
  originIncidentId: string | null
  currentStatus: ReportUpdateStatus
  updates: ReportUpdateData[]
  /** Total updates on the report, including pages past the first. */
  updatesCount?: number
  /** Opaque cursor for older timeline pages, or null when complete. */
  updatesNextCursor?: string | null
  affected: ReportAffectedData[]
  createdAt: string
  updatedAt: string
}

/**
 * Row shape for the reports list: mirrors the lean serialization of
 * listStatusReportSummaries (counts + latest update, never markdown).
 */
export interface ReportListRowData {
  id: string
  type: ReportType
  title: string
  publishedAt: string | null
  currentStatus: ReportUpdateStatus
  updatesCount: number
  latestUpdate: { status: ReportUpdateStatus; publishedAt: string } | null
}

export type ReportListState = "all" | "draft" | "ongoing" | "resolved"
export type ReportListType = "all" | "incident" | "maintenance"

/** Maps a report's current status onto the house StatusDot vocabulary. */
export function reportDotState(
  status: ReportUpdateStatus
): VisibleMonitorState {
  switch (status) {
    case "investigating":
    case "identified":
      return "DOWN"
    case "monitoring":
    case "in_progress":
      return "VERIFYING_UP"
    case "resolved":
    case "completed":
      return "UP"
    case "scheduled":
      return "PENDING"
  }
}

export interface UpdateEdit {
  id: string
  status?: ReportUpdateStatus
  publishedAt?: string
}

interface RankedUpdate {
  id: string
  status: ReportUpdateStatus
  publishedAt: number
  createdAt: number | null
  rank: number
}

/**
 * Descending mirror of the server's contract total order for updates:
 * (publishedAt, createdAt, id). Only when createdAt is absent on either side
 * (older payloads) does the original newest-first array order stand in for
 * the tiebreak, since the server produced it in that same total order.
 */
function compareNewestFirst(left: RankedUpdate, right: RankedUpdate): number {
  if (left.publishedAt !== right.publishedAt) {
    return right.publishedAt - left.publishedAt
  }
  if (left.createdAt !== null && right.createdAt !== null) {
    if (left.createdAt !== right.createdAt) {
      return right.createdAt - left.createdAt
    }
    if (left.id !== right.id) {
      return left.id > right.id ? -1 : 1
    }
    return 0
  }
  return left.rank - right.rank
}

function toCandidates(
  updatesNewestFirst: readonly ReportUpdateData[],
  edit?: UpdateEdit
): RankedUpdate[] {
  return updatesNewestFirst.map((update, index) => {
    const edited = edit !== undefined && update.id === edit.id
    const publishedAt =
      edited && edit.publishedAt !== undefined
        ? edit.publishedAt
        : update.publishedAt
    return {
      id: update.id,
      status: edited && edit.status !== undefined ? edit.status : update.status,
      publishedAt: new Date(publishedAt).getTime(),
      createdAt:
        update.createdAt === undefined
          ? null
          : new Date(update.createdAt).getTime(),
      rank: index,
    }
  })
}

/**
 * Recomputes the report's current status after applying a pending edit to one
 * update, using the contract total order (publishedAt, createdAt, id). Edits
 * never change createdAt, so the loaded value (when present) keeps the client
 * derivation identical to the server's, including minute-precision ties.
 */
export function currentStatusAfterEdit(
  updatesNewestFirst: readonly ReportUpdateData[],
  edit: UpdateEdit
): ReportUpdateStatus | null {
  const candidates = toCandidates(updatesNewestFirst, edit).sort(
    compareNewestFirst
  )
  return candidates[0]?.status ?? null
}

export type StateFlipDirection = "to_ongoing" | "to_resolved"

/**
 * Detects whether editing an update's publishedAt or status flips the report
 * between Ongoing and Resolved.
 */
export function stateFlipDirection(
  updatesNewestFirst: readonly ReportUpdateData[],
  edit: UpdateEdit
): StateFlipDirection | null {
  const first = updatesNewestFirst[0]
  const before = first ? isResolvingStatus(first.status) : false
  const afterStatus = currentStatusAfterEdit(updatesNewestFirst, edit)
  const after = afterStatus !== null && isResolvingStatus(afterStatus)
  if (before === after) {
    return null
  }
  return after ? "to_resolved" : "to_ongoing"
}

/**
 * Detects whether removing an update flips the report between Ongoing and
 * Resolved. Returns null for the last remaining update. The server refuses
 * that deletion outright (LAST_UPDATE).
 */
export function stateFlipAfterRemoval(
  updatesNewestFirst: readonly ReportUpdateData[],
  removeId: string
): StateFlipDirection | null {
  const first = updatesNewestFirst[0]
  const before = first ? isResolvingStatus(first.status) : false
  const remaining = updatesNewestFirst.filter(
    (update) => update.id !== removeId
  )
  if (remaining.length === 0) {
    return null
  }
  const afterStatus =
    toCandidates(remaining).sort(compareNewestFirst)[0]?.status ?? null
  const after = afterStatus !== null && isResolvingStatus(afterStatus)
  if (before === after) {
    return null
  }
  return after ? "to_resolved" : "to_ongoing"
}

export const STATE_FLIP_COPY: Record<StateFlipDirection, string> = {
  to_ongoing:
    "This moves the report back to Ongoing — it will reappear at the top of your status page.",
  to_resolved:
    "This marks the report as Resolved — it will move into your status page history.",
}

export function formatUpdateCount(count: number): string {
  return count === 1 ? "1 update" : `${count} updates`
}

/**
 * Renders an ISO timestamp as a datetime-local input value. Uses `timeZone`
 * when given, otherwise the browser's local zone.
 */
export function toDatetimeLocal(iso: string, timeZone?: string): string {
  if (timeZone) {
    return formatDatetimeInput(iso, timeZone)
  }
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Parses a datetime-local input value back to ISO, or null when unparseable.
 * With `timeZone`, a time skipped or repeated by a daylight-saving change is
 * null, since it names no single instant. Without it, the browser's local
 * zone applies.
 */
export function fromDatetimeLocal(
  value: string,
  timeZone?: string
): string | null {
  if (!value.trim()) {
    return null
  }
  if (timeZone) {
    const parsed = parseDatetimeInput(value, timeZone)
    return parsed.status === "ok" ? parsed.iso : null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Resolves a datetime-local value to ISO. A value still showing `original`
 * keeps that exact instant, so untouched fields never lose seconds or fail
 * on a repeated daylight-saving hour.
 */
export function resolveDatetimeLocal(
  value: string,
  timeZone?: string,
  original?: string | null
): string | null {
  if (!value.trim()) {
    return null
  }
  if (original && value === toDatetimeLocal(original, timeZone)) {
    return original
  }
  return fromDatetimeLocal(value, timeZone)
}

/** Names a wall time that a daylight-saving change skips or repeats. */
function clockChangeError(
  value: string,
  timeZone?: string
): string | undefined {
  if (!timeZone) {
    return
  }
  const parsed = parseDatetimeInput(value, timeZone)
  if (parsed.status === "ambiguous") {
    return "Time repeats at clock change"
  }
  if (parsed.status === "nonexistent") {
    return "Time skipped at clock change"
  }
}

/**
 * Field error for a datetime-local value that resolves to no single
 * instant, or undefined when it resolves.
 */
export function datetimeLocalError(
  value: string,
  timeZone?: string,
  original?: string | null
): string | undefined {
  if (resolveDatetimeLocal(value, timeZone, original)) {
    return
  }
  return clockChangeError(value, timeZone) ?? "Enter a valid time"
}

export const BEFORE_START_COPY =
  "This update is dated before the report's start time"

export interface DatetimeOriginals {
  startsAt?: string | null
  endsAt?: string | null
  publishedAt?: string | null
}

/**
 * Non-blocking warning: true when both datetime-local values parse and the
 * update's published time falls before the report's start time.
 */
export function isBeforeStart(
  publishedAtLocal: string,
  startsAtLocal: string,
  timeZone?: string,
  originals: DatetimeOriginals = {}
): boolean {
  const publishedAt = resolveDatetimeLocal(
    publishedAtLocal,
    timeZone,
    originals.publishedAt
  )
  const startsAt = resolveDatetimeLocal(
    startsAtLocal,
    timeZone,
    originals.startsAt
  )
  return (
    publishedAt !== null &&
    startsAt !== null &&
    new Date(publishedAt).getTime() < new Date(startsAt).getTime()
  )
}

export interface ReportFormErrors {
  title?: string
  startsAt?: string
  endsAt?: string
  markdown?: string
  publishedAt?: string
}

const MAX_REPORT_MARKDOWN = 10_240

export function validateReportForm(input: {
  title: string
  startsAt: string
  endsAt: string
  type: ReportType
  requireUpdate: boolean
  markdown: string
  publishedAt: string
  /** Display zone the datetime fields are typed in. Browser zone if absent. */
  timeZone?: string
  /** Loaded instants, so untouched fields keep their exact value. */
  originals?: DatetimeOriginals
}): ReportFormErrors {
  const errors: ReportFormErrors = {}
  const { timeZone, originals = {} } = input
  if (!input.title.trim()) {
    errors.title = "Enter a title"
  } else if (input.title.trim().length > 160) {
    errors.title = "Use 160 characters or fewer"
  }
  const startsAt = resolveDatetimeLocal(
    input.startsAt,
    timeZone,
    originals.startsAt
  )
  if (!startsAt) {
    errors.startsAt =
      clockChangeError(input.startsAt, timeZone) ?? "Enter a start time"
  }
  if (input.type === "maintenance" && input.endsAt.trim()) {
    const endsAt = resolveDatetimeLocal(
      input.endsAt,
      timeZone,
      originals.endsAt
    )
    if (!endsAt) {
      errors.endsAt =
        clockChangeError(input.endsAt, timeZone) ?? "Enter a valid end time"
    } else if (
      startsAt &&
      new Date(endsAt).getTime() <= new Date(startsAt).getTime()
    ) {
      errors.endsAt = "End must be after start"
    }
  }
  if (input.requireUpdate) {
    if (!input.markdown.trim()) {
      errors.markdown = "Write the first update"
    } else if (input.markdown.length > MAX_REPORT_MARKDOWN) {
      errors.markdown = "Use 10 KB or fewer"
    }
    if (
      !resolveDatetimeLocal(input.publishedAt, timeZone, originals.publishedAt)
    ) {
      errors.publishedAt =
        clockChangeError(input.publishedAt, timeZone) ?? "Enter a valid time"
    }
  }
  return errors
}
