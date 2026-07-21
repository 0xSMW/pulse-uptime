import "server-only"

import { Buffer } from "node:buffer"
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm"
import { unionAll } from "drizzle-orm/pg-core"
import { z } from "zod"
import type { DatabaseHandle } from "@/lib/db/client"
import { db } from "@/lib/db/client"
import {
  incidents,
  monitorRegistry,
  monitorState,
  statusReportAffected,
  type statusReportImpacts,
  statusReports,
  type statusReportTypes,
  type statusReportUpdateStatuses,
  statusReportUpdates,
} from "@/lib/db/schema"
import { isUuid } from "@/lib/ids/uuid"
import {
  IMPACT_BY_TYPE,
  INCIDENT_UPDATE_STATUSES,
  MAINTENANCE_UPDATE_STATUSES,
  RESOLVING_STATUSES,
} from "@/lib/status-reports/domain"
import {
  getPublicReports,
  requireStatusReport,
} from "@/lib/status-reports/queries"

import { decodeTimestampUuidCursor, encodeCursor } from "./pagination"

// The vocabulary lives in the client-safe domain module. The two status arrays
// stay exported from here for the callers that import them off this module.
// The two reporting-facing reads live in lib/status-reports/queries now.
// Re-exported so existing API-layer callers keep importing them from here.
export {
  getPublicReports,
  INCIDENT_UPDATE_STATUSES,
  MAINTENANCE_UPDATE_STATUSES,
  requireStatusReport,
}

/**
 * Status reports service. Store-injected like lib/api/account.ts:
 * routes call the exported functions with the default database store. Tests
 * inject an in-memory store and exercise the normative rules directly.
 *
 * Normative rules implemented here (they are part of the API contract):
 * - Current status = the latest update ordered by (publishedAt, createdAt, id).
 * - resolvedAt is recomputed from the FULL update set on every update
 *   create/edit/delete: null unless the latest update is resolved/completed.
 * - createStatusReport requires the initial update, deleteReportUpdate refuses
 *   the last one (LAST_UPDATE), publish is one-way (second call fails with
 *   ALREADY_PUBLISHED), promotion always creates a draft and is idempotent via
 *   the partial unique index on originIncidentId.
 */

export type StatusReportType = (typeof statusReportTypes)[number]
export type StatusReportUpdateStatus =
  (typeof statusReportUpdateStatuses)[number]
export type StatusReportImpact = (typeof statusReportImpacts)[number]

export interface StatusReportRow {
  id: string
  type: StatusReportType
  title: string
  startsAt: Date
  endsAt: Date | null
  publishedAt: Date | null
  resolvedAt: Date | null
  originIncidentId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface StatusReportUpdateRow {
  id: string
  reportId: string
  status: StatusReportUpdateStatus
  markdown: string
  publishedAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface StatusReportAffectedRow {
  reportId: string
  monitorId: string
  monitorName: string
  groupName: string | null
  impact: StatusReportImpact
}

export interface StatusReportUpdateData {
  id: string
  status: StatusReportUpdateStatus
  markdown: string
  publishedAt: string
  /**
   * RFC 3339. Serialized so clients can reproduce the exact server total
   * order (publishedAt, createdAt, id) for backdated-timestamp ties.
   */
  createdAt: string
}

export interface AffectedServiceData {
  monitorId: string
  monitorName: string
  groupName: string | null
  impact: StatusReportImpact
}

export interface StatusReportData {
  id: string
  type: StatusReportType
  title: string
  startsAt: string
  endsAt: string | null
  publishedAt: string | null
  resolvedAt: string | null
  originIncidentId: string | null
  currentStatus: StatusReportUpdateStatus
  /**
   * First page of the timeline, newest first by (publishedAt, createdAt, id).
   * Older pages load via GET .../updates with updatesNextCursor.
   */
  updates: StatusReportUpdateData[]
  /** Total updates on the report, including those past the first page. */
  updatesCount: number
  /** Opaque cursor for the next older page, or null when updates is complete. */
  updatesNextCursor: string | null
  affected: AffectedServiceData[]
  createdAt: string
  updatedAt: string
}

/** First page size on report detail and mutation responses. */
export const DETAIL_UPDATES_PAGE_SIZE = 50

/**
 * List-shaped row: everything a report list needs without the
 * markdown bodies or the full update timeline. `requireStatusReport` keeps the
 * detailed shape.
 */
export interface StatusReportListItemData {
  id: string
  type: StatusReportType
  title: string
  startsAt: string
  endsAt: string | null
  publishedAt: string | null
  resolvedAt: string | null
  originIncidentId: string | null
  currentStatus: StatusReportUpdateStatus
  updatesCount: number
  latestUpdate: { status: StatusReportUpdateStatus; publishedAt: string } | null
  affected: AffectedServiceData[]
  createdAt: string
  updatedAt: string
}

export type StatusReportListState = "all" | "draft" | "ongoing" | "resolved"
export type StatusReportListType = "all" | "incident" | "maintenance"

export class StatusReportError extends Error {
  constructor(
    readonly code:
      | "VALIDATION_ERROR"
      | "REPORT_NOT_FOUND"
      | "UPDATE_NOT_FOUND"
      | "INCIDENT_NOT_FOUND"
      | "LAST_UPDATE"
      | "ALREADY_PUBLISHED"
      | "INVALID_CURSOR",
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = "StatusReportError"
  }
}

export interface StatusReportsStore {
  findMonitors: (
    ids: readonly string[]
  ) => Promise<Array<{ id: string; name: string; groupName: string | null }>>
  insertReport: (input: {
    report: StatusReportRow
    update: StatusReportUpdateRow
    affected: StatusReportAffectedRow[]
  }) => Promise<void>
  /** Insert honoring the partial unique index on originIncidentId. */
  insertPromotedReport: (input: {
    report: StatusReportRow
    update: StatusReportUpdateRow
    affected: StatusReportAffectedRow[]
  }) => Promise<{ id: string; created: boolean }>
  getReport: (id: string) => Promise<StatusReportRow | null>
  listReports: (input: {
    state: StatusReportListState
    type: StatusReportListType
    cursor: { createdAt: Date; id: string } | null
    limit: number
  }) => Promise<StatusReportRow[]>
  getReportDetails: (ids: readonly string[]) => Promise<{
    /** First DETAIL_UPDATES_PAGE_SIZE updates per report, newest first order. */
    updates: StatusReportUpdateRow[]
    counts: Array<{ reportId: string; count: number }>
    affected: StatusReportAffectedRow[]
  }>
  /**
   * List-path details: per-report update counts + the latest update's status
   * and publishedAt (via the contract total order), never markdown bodies.
   */
  getListDetails: (ids: readonly string[]) => Promise<{
    counts: Array<{ reportId: string; count: number }>
    latest: Array<{
      reportId: string
      status: StatusReportUpdateStatus
      publishedAt: Date
    }>
    affected: StatusReportAffectedRow[]
  }>
  /**
   * Keyset page of one report's updates, descending (publishedAt, createdAt,
   * id). Callers request limit+1 to detect a following page. Cursor is the
   * last row of the prior page (exclusive upper bound in descending order).
   */
  listReportUpdates: (input: {
    reportId: string
    cursor: { publishedAt: Date; createdAt: Date; id: string } | null
    limit: number
  }) => Promise<StatusReportUpdateRow[]>
  /**
   * Locked report update: SELECT FOR UPDATE, merge patch against the locked
   * row, validate the effective maintenance window, resolve affected monitor
   * snapshots inside the same transaction, then write. Throws StatusReportError
   * for window/type/monitor validation failures so concurrent start/end
   * patches serialize to one invalid loser and one valid final row.
   */
  updateReport: (input: {
    id: string
    patch: { title?: string; startsAt?: Date; endsAt?: Date | null }
    /**
     * When defined, full replacement. Resolved against the live registry
     * inside the report lock (not from a pre-transaction snapshot).
     */
    affectedEntries:
      | ReadonlyArray<{ monitorId: string; impact: StatusReportImpact }>
      | undefined
    now: Date
  }) => Promise<StatusReportRow | null>
  deleteReport: (id: string) => Promise<boolean>
  insertUpdate: (row: StatusReportUpdateRow) => Promise<void>
  /**
   * Row-locked insert for addReportUpdate: locks the report (`FOR UPDATE`,
   * mirroring deleteUpdate/recomputeResolution) and re-verifies it still
   * exists INSIDE the same transaction as the insert, closing the race
   * where a concurrent DELETE commits between an earlier existence check and
   * this insert, which must surface as REPORT_NOT_FOUND, never a raw
   * report_id foreign-key violation. Returns the locked report row, or null
   * if it no longer exists, in which case nothing is inserted.
   */
  insertReportUpdate: (input: {
    reportId: string
    update: StatusReportUpdateRow
  }) => Promise<StatusReportRow | null>
  editUpdate: (input: {
    reportId: string
    updateId: string
    patch: {
      status?: StatusReportUpdateStatus
      markdown?: string
      publishedAt?: Date
    }
    now: Date
  }) => Promise<StatusReportUpdateRow | null>
  /**
   * Transactional guarded delete: the report row is locked (`FOR UPDATE`) so
   * concurrent deletes on the same report serialize before the surviving
   * count is read, then the row is removed only while at least one other
   * update for the report exists. "last_update" = the row exists but is the
   * report's final update, "missing" = no such row.
   */
  deleteUpdate: (input: {
    reportId: string
    updateId: string
  }) => Promise<"deleted" | "last_update" | "missing">
  /**
   * Recomputes and persists the report's resolvedAt from the FULL current
   * update set, inside a `SELECT ... FOR UPDATE`-locked transaction on the
   * report row (mirrors deleteUpdate's guard): concurrent mutations against
   * the SAME report must serialize their recompute+write, never race as a
   * list-then-derive-then-write outside any lock, where a lagging recompute
   * could clobber a newer, correct write with a stale value. Returns the
   * updates read inside the lock (so the caller serializes the response from
   * the same consistent snapshot) and the resolvedAt persisted, or null if the
   * report no longer exists.
   */
  recomputeResolution: (input: { reportId: string; now: Date }) => Promise<{
    updates: StatusReportUpdateRow[]
    resolvedAt: Date | null
  } | null>
  publishReport: (input: {
    id: string
    now: Date
  }) => Promise<"published" | "already_published" | "missing">
  findIncident: (incidentId: string) => Promise<{
    id: string
    monitorId: string
    monitorName: string
    groupName: string | null
    openedAt: Date
    openingStatusCode: number | null
  } | null>
  /** Query 1 of getPublicReports: published ongoing/upcoming + recent resolved. */
  getPublicReportRows: (input: {
    resolvedLimit: number
    now: Date
    filter?: PublicReportRowsFilter
  }) => Promise<StatusReportRow[]>
  /**
   * Distinct group names ever snapshotted into affected rows, null included.
   * Backs slug scoping in getPublicReports: statusGroupSlug cannot be
   * reproduced faithfully in SQL (NFKD normalization, diacritics), so the
   * service enumerates the snapshot names, slugs them in JS, and hands the
   * exact matching names to getPublicReportRows for raw-string comparison.
   */
  getAffectedGroupNames: () => Promise<Array<string | null>>
  /** Query 2: latest update per report via DISTINCT ON, total-order aligned. */
  getLatestUpdates: (
    reportIds: readonly string[]
  ) => Promise<StatusReportUpdateRow[]>
  /** Query 3: affected rows for the page of reports. */
  getAffected: (
    reportIds: readonly string[]
  ) => Promise<StatusReportAffectedRow[]>
}

export interface StatusReportsDependencies {
  store?: StatusReportsStore
  now?: () => Date
  newId?: () => string
  /**
   * Pins createStatusReport's (or promoteIncident's) report id instead of
   * drawing one from newId(). The POST route sets this to the idempotency
   * operationId, so the same retried operation always names the same row
   * even across a stale-record reclaim that reruns work().
   */
  reportId?: string
  /** Same idea as reportId, for addReportUpdate's new update row. */
  updateId?: string
}

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

/**
 * Strict RFC 3339 acceptance: the string must be shaped right, Date.parse
 * must accept it, AND the parsed instant must round-trip back to the exact
 * calendar components the caller wrote. The round-trip is what rejects
 * impossible dates Date.parse silently normalizes (2026-02-31 becomes
 * March 3, 24:00:00 becomes the next day's midnight): a typo in startsAt,
 * endsAt, or a backdated publishedAt must fail as VALIDATION_ERROR, never
 * publish a silently shifted incident or maintenance time.
 */
function isStrictRfc3339(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value)
  if (!match) {
    return false
  }
  const epochMs = Date.parse(value)
  if (Number.isNaN(epochMs)) {
    return false
  }
  const offset = match[7]!
  const offsetMinutes =
    offset === "Z" || offset === "z"
      ? 0
      : (offset.startsWith("-") ? -1 : 1) *
        (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)))
  // Shifting the UTC instant by the written offset reconstructs the caller's
  // wall-clock components, so getUTC* reads them back for comparison.
  const wallClock = new Date(epochMs + offsetMinutes * 60_000)
  return (
    wallClock.getUTCFullYear() === Number(match[1]) &&
    wallClock.getUTCMonth() + 1 === Number(match[2]) &&
    wallClock.getUTCDate() === Number(match[3]) &&
    wallClock.getUTCHours() === Number(match[4]) &&
    wallClock.getUTCMinutes() === Number(match[5]) &&
    wallClock.getUTCSeconds() === Number(match[6])
  )
}

const timestampSchema = z
  .string()
  .refine(isStrictRfc3339, { message: "Must be an RFC 3339 timestamp" })
  .transform((value) => new Date(value))

export const MAX_MARKDOWN_LENGTH = 10_240

const titleSchema = z
  .string()
  .trim()
  .min(1, "Title is required")
  .max(160, "Title must be at most 160 characters")
const markdownSchema = z
  .string()
  .max(MAX_MARKDOWN_LENGTH, "Update body must be at most 10 KB")
  .refine((value) => value.trim().length > 0, {
    message: "Update body is required",
  })

const updateStatusSchema = z.enum([
  ...INCIDENT_UPDATE_STATUSES,
  ...MAINTENANCE_UPDATE_STATUSES,
])

const affectedEntrySchema = z
  .object({
    monitorId: z.string().trim().min(1),
    impact: z.enum(["down", "degraded", "maintenance"]),
  })
  .strict()

/**
 * Per-report cap on affected monitors, enforced both at the input schema and
 * as the multiplier the affected-row read caps derive from (reportIds.length
 * MAX_AFFECTED_PER_REPORT) so a global cap can never truncate a page of
 * reports that are each individually within bounds.
 */
export const MAX_AFFECTED_PER_REPORT = 100

const affectedListSchema = z
  .array(affectedEntrySchema)
  .max(MAX_AFFECTED_PER_REPORT)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.monitorId)).size === entries.length,
    { message: "Affected monitors must be unique" }
  )

const createSchema = z
  .object({
    type: z.enum(["incident", "maintenance"]),
    title: titleSchema,
    startsAt: timestampSchema.optional(),
    endsAt: timestampSchema.nullish(),
    affected: affectedListSchema.optional(),
    update: z
      .object({
        status: updateStatusSchema,
        markdown: markdownSchema,
        publishedAt: timestampSchema.optional(),
      })
      .strict(),
    draft: z.boolean().optional(),
  })
  .strict()

const patchSchema = z
  .object({
    title: titleSchema.optional(),
    startsAt: timestampSchema.optional(),
    endsAt: timestampSchema.nullable().optional(),
    affected: affectedListSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update",
  })

const updateCreateSchema = z
  .object({
    status: updateStatusSchema,
    markdown: markdownSchema,
    publishedAt: timestampSchema.optional(),
  })
  .strict()

const updateEditSchema = z
  .object({
    status: updateStatusSchema.optional(),
    markdown: markdownSchema.optional(),
    publishedAt: timestampSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update",
  })

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    throw new StatusReportError(
      "VALIDATION_ERROR",
      `Invalid status report request${at}: ${issue?.message ?? "invalid input"}`,
      {
        issues: parsed.error.issues.map((entry) => ({
          path: entry.path.join("."),
          message: entry.message,
        })),
      }
    )
  }
  return parsed.data
}

function assertStatusMatchesType(
  type: StatusReportType,
  status: StatusReportUpdateStatus
) {
  const allowed: readonly string[] =
    type === "incident" ? INCIDENT_UPDATE_STATUSES : MAINTENANCE_UPDATE_STATUSES
  if (!allowed.includes(status)) {
    throw new StatusReportError(
      "VALIDATION_ERROR",
      `Update status must be one of ${allowed.join(", ")} for ${type} reports`,
      { status }
    )
  }
}

function assertAffectedMatchesType(
  type: StatusReportType,
  entries: ReadonlyArray<{ monitorId: string; impact: StatusReportImpact }>
) {
  const allowed = IMPACT_BY_TYPE[type]
  for (const entry of entries) {
    if (!allowed.includes(entry.impact)) {
      throw new StatusReportError(
        "VALIDATION_ERROR",
        `Affected impact must be one of ${allowed.join(", ")} for ${type} reports`,
        { monitorId: entry.monitorId, impact: entry.impact }
      )
    }
  }
}

/**
 * Incidents have no scheduled window, only maintenance reports do. Rejecting
 * endsAt on an incident at the boundary (rather than merely ignoring it) keeps
 * classifyPublicReport's maintenance-only window_ended demotion correct by
 * construction: an incident can never carry an endsAt for getPublicReportRows'
 * ended-window ORDER BY bucket to misclassify, so a still-ongoing incident can
 * never be pushed past the public 100-row cap by a bucket it should never be
 * in. Classification and the SQL ranking must always agree on whether an
 * incident's window has "ended".
 */
function assertNoIncidentWindow(
  type: StatusReportType,
  endsAt: Date | null | undefined
) {
  if (type === "incident" && endsAt != null) {
    throw new StatusReportError(
      "VALIDATION_ERROR",
      "endsAt is not allowed for incident reports",
      { type }
    )
  }
}

/**
 * Total order for updates: (publishedAt, createdAt, id). The tiebreak is part
 * of the API contract: backdated updates with identical timestamps resolve
 * deterministically everywhere (service, DISTINCT ON query, public page).
 */
export function compareReportUpdates(
  left: StatusReportUpdateRow,
  right: StatusReportUpdateRow
): number {
  return (
    left.publishedAt.getTime() - right.publishedAt.getTime() ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}

export function latestReportUpdate(
  updates: readonly StatusReportUpdateRow[]
): StatusReportUpdateRow | null {
  if (updates.length === 0) {
    return null
  }
  return [...updates].sort(compareReportUpdates).at(-1) ?? null
}

/** null unless the latest update (by the total order) resolves the report. */
export function deriveResolvedAt(
  updates: readonly StatusReportUpdateRow[]
): Date | null {
  const latest = latestReportUpdate(updates)
  if (!(latest && RESOLVING_STATUSES.includes(latest.status))) {
    return null
  }
  return latest.publishedAt
}

function serializeAffected(
  affected: readonly StatusReportAffectedRow[]
): AffectedServiceData[] {
  return [...affected]
    .sort((left, right) => left.monitorId.localeCompare(right.monitorId))
    .map((row) => ({
      monitorId: row.monitorId,
      monitorName: row.monitorName,
      groupName: row.groupName,
      impact: row.impact,
    }))
}

/**
 * Local triple-key cursor for update timelines ordered by
 * (publishedAt, createdAt, id). CURSOR-01 covers timestamp+UUID pairs; multi-sort
 * keysets stay local until INT unifies them.
 */
interface ReportUpdateCursorValue {
  publishedAt: string
  createdAt: string
  id: string
}

// Matches Date.prototype.toISOString() so wire cursors stay stable.
const UPDATE_CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function encodeReportUpdateCursor(value: ReportUpdateCursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

export function decodeReportUpdateCursor(
  value: string | null
):
  | { ok: true; cursor: ReportUpdateCursorValue | null }
  | { ok: false } {
  if (value === null) {
    return { ok: true, cursor: null }
  }
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
    const record = parsed as Partial<ReportUpdateCursorValue>
    if (
      typeof record.publishedAt !== "string" ||
      typeof record.createdAt !== "string" ||
      typeof record.id !== "string"
    ) {
      return { ok: false }
    }
    if (
      !(
        UPDATE_CURSOR_TS.test(record.publishedAt) &&
        UPDATE_CURSOR_TS.test(record.createdAt) &&
        isUuid(record.id)
      )
    ) {
      return { ok: false }
    }
    const publishedAt = new Date(record.publishedAt)
    const createdAt = new Date(record.createdAt)
    if (
      Number.isNaN(publishedAt.getTime()) ||
      Number.isNaN(createdAt.getTime()) ||
      publishedAt.toISOString() !== record.publishedAt ||
      createdAt.toISOString() !== record.createdAt
    ) {
      return { ok: false }
    }
    return {
      ok: true,
      cursor: {
        publishedAt: record.publishedAt,
        createdAt: record.createdAt,
        id: record.id,
      },
    }
  } catch {
    return { ok: false }
  }
}

function serializeUpdateRow(update: StatusReportUpdateRow): StatusReportUpdateData {
  return {
    id: update.id,
    status: update.status,
    markdown: update.markdown,
    publishedAt: update.publishedAt.toISOString(),
    createdAt: update.createdAt.toISOString(),
  }
}

/**
 * Pages a full in-memory update set for detail/mutation responses: newest
 * DETAIL_UPDATES_PAGE_SIZE rows plus truncation metadata.
 */
function pageUpdatesForDetail(updates: readonly StatusReportUpdateRow[]): {
  page: StatusReportUpdateRow[]
  updatesCount: number
  updatesNextCursor: string | null
} {
  const newestFirst = [...updates].sort((left, right) =>
    compareReportUpdates(right, left)
  )
  const page = newestFirst.slice(0, DETAIL_UPDATES_PAGE_SIZE)
  const last = page.at(-1)
  return {
    page,
    updatesCount: newestFirst.length,
    updatesNextCursor:
      newestFirst.length > DETAIL_UPDATES_PAGE_SIZE && last
        ? encodeReportUpdateCursor({
            publishedAt: last.publishedAt.toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  }
}

function nextCursorFromPage(
  page: readonly StatusReportUpdateRow[],
  updatesCount: number
): string | null {
  // Sort first: getReportDetails does not order rows within a report.
  const newestFirst = [...page].sort((left, right) =>
    compareReportUpdates(right, left)
  )
  const last = newestFirst.at(-1)
  if (!(last && updatesCount > newestFirst.length)) {
    return null
  }
  return encodeReportUpdateCursor({
    publishedAt: last.publishedAt.toISOString(),
    createdAt: last.createdAt.toISOString(),
    id: last.id,
  })
}

export function serializeReport(
  report: StatusReportRow,
  updates: readonly StatusReportUpdateRow[],
  affected: readonly StatusReportAffectedRow[],
  truncation?: { updatesCount: number; updatesNextCursor: string | null }
): StatusReportData {
  const newestFirst = [...updates].sort((left, right) =>
    compareReportUpdates(right, left)
  )
  // When the caller already paged (detail load, listReportUpdates), trust
  // their count/cursor. Otherwise page a full in-memory set for mutations
  // that recompute against every update.
  const paged = truncation
    ? {
        page: newestFirst,
        updatesCount: truncation.updatesCount,
        updatesNextCursor: truncation.updatesNextCursor,
      }
    : pageUpdatesForDetail(newestFirst)
  return {
    id: report.id,
    type: report.type,
    title: report.title,
    startsAt: report.startsAt.toISOString(),
    endsAt: report.endsAt?.toISOString() ?? null,
    publishedAt: report.publishedAt?.toISOString() ?? null,
    resolvedAt: report.resolvedAt?.toISOString() ?? null,
    originIncidentId: report.originIncidentId,
    currentStatus:
      paged.page[0]?.status ??
      (report.type === "incident" ? "investigating" : "scheduled"),
    updates: paged.page.map(serializeUpdateRow),
    updatesCount: paged.updatesCount,
    updatesNextCursor: paged.updatesNextCursor,
    affected: serializeAffected(affected),
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  }
}

async function snapshotAffected(
  store: StatusReportsStore,
  reportId: string,
  entries: ReadonlyArray<{ monitorId: string; impact: StatusReportImpact }>
): Promise<StatusReportAffectedRow[]> {
  if (entries.length === 0) {
    return []
  }
  const monitors = await store.findMonitors(
    entries.map((entry) => entry.monitorId)
  )
  const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]))
  return entries.map((entry) => {
    const monitor = byId.get(entry.monitorId)
    if (!monitor) {
      throw new StatusReportError(
        "VALIDATION_ERROR",
        `Affected monitor "${entry.monitorId}" was not found`,
        {
          monitorId: entry.monitorId,
        }
      )
    }
    return {
      reportId,
      monitorId: monitor.id,
      monitorName: monitor.name,
      groupName: monitor.groupName,
      impact: entry.impact,
    }
  })
}

async function loadReportData(
  store: StatusReportsStore,
  report: StatusReportRow
): Promise<StatusReportData> {
  const { updates, counts, affected } = await store.getReportDetails([
    report.id,
  ])
  const updatesCount =
    counts.find((entry) => entry.reportId === report.id)?.count ?? updates.length
  return serializeReport(report, updates, affected, {
    updatesCount,
    updatesNextCursor: nextCursorFromPage(updates, updatesCount),
  })
}

export function parseStatusReportListQuery(input: {
  state: string | null
  type: string | null
  cursor: string | null
}): {
  state: StatusReportListState
  type: StatusReportListType
  cursor: { createdAt: Date; id: string } | null
} {
  const state = input.state ?? "all"
  const type = input.type ?? "all"
  if (!["all", "draft", "ongoing", "resolved"].includes(state)) {
    throw new StatusReportError(
      "VALIDATION_ERROR",
      "State must be all, draft, ongoing, or resolved"
    )
  }
  if (!["all", "incident", "maintenance"].includes(type)) {
    throw new StatusReportError(
      "VALIDATION_ERROR",
      "Type must be all, incident, or maintenance"
    )
  }
  const decoded = decodeTimestampUuidCursor(input.cursor)
  if (!decoded.ok) {
    throw new StatusReportError("INVALID_CURSOR", "Cursor is invalid")
  }
  const cursor: { createdAt: Date; id: string } | null = decoded.cursor
    ? { createdAt: decoded.cursor.sort, id: decoded.cursor.id }
    : null
  return {
    state: state as StatusReportListState,
    type: type as StatusReportListType,
    cursor,
  }
}

export async function listStatusReports(
  input: {
    state: StatusReportListState
    type: StatusReportListType
    cursor: { createdAt: Date; id: string } | null
    limit: number
  },
  dependencies: StatusReportsDependencies = {}
): Promise<{ data: StatusReportData[]; nextCursor: string | null }> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const rows = await store.listReports(input)
  const page = rows.slice(0, input.limit)
  const { updates, counts, affected } =
    page.length > 0
      ? await store.getReportDetails(page.map((row) => row.id))
      : { updates: [], counts: [], affected: [] }
  const countByReport = new Map(
    counts.map((entry) => [entry.reportId, entry.count])
  )
  const last = page.at(-1)
  return {
    data: page.map((report) => {
      const reportUpdates = updates.filter(
        (update) => update.reportId === report.id
      )
      const updatesCount = countByReport.get(report.id) ?? reportUpdates.length
      return serializeReport(
        report,
        reportUpdates,
        affected.filter((row) => row.reportId === report.id),
        {
          updatesCount,
          updatesNextCursor: nextCursorFromPage(reportUpdates, updatesCount),
        }
      )
    }),
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor({ sort: last.createdAt.toISOString(), id: last.id })
        : null,
  }
}

/**
 * List path: one page query + one batched details fan-out (counts,
 * DISTINCT ON latest status/publishedAt, affected). Never fetches markdown,
 * the detailed shape stays on requireStatusReport.
 */
export async function listStatusReportSummaries(
  input: {
    state: StatusReportListState
    type: StatusReportListType
    cursor: { createdAt: Date; id: string } | null
    limit: number
  },
  dependencies: StatusReportsDependencies = {}
): Promise<{ data: StatusReportListItemData[]; nextCursor: string | null }> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const rows = await store.listReports(input)
  const page = rows.slice(0, input.limit)
  const { counts, latest, affected } =
    page.length > 0
      ? await store.getListDetails(page.map((row) => row.id))
      : { counts: [], latest: [], affected: [] }
  const countByReport = new Map(
    counts.map((entry) => [entry.reportId, entry.count])
  )
  const latestByReport = new Map(latest.map((entry) => [entry.reportId, entry]))
  const last = page.at(-1)
  return {
    data: page.map((report) => {
      const latestUpdate = latestByReport.get(report.id) ?? null
      return {
        id: report.id,
        type: report.type,
        title: report.title,
        startsAt: report.startsAt.toISOString(),
        endsAt: report.endsAt?.toISOString() ?? null,
        publishedAt: report.publishedAt?.toISOString() ?? null,
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        originIncidentId: report.originIncidentId,
        currentStatus:
          latestUpdate?.status ??
          (report.type === "incident" ? "investigating" : "scheduled"),
        updatesCount: countByReport.get(report.id) ?? 0,
        latestUpdate: latestUpdate
          ? {
              status: latestUpdate.status,
              publishedAt: latestUpdate.publishedAt.toISOString(),
            }
          : null,
        affected: serializeAffected(
          affected.filter((row) => row.reportId === report.id)
        ),
        createdAt: report.createdAt.toISOString(),
        updatedAt: report.updatedAt.toISOString(),
      }
    }),
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor({ sort: last.createdAt.toISOString(), id: last.id })
        : null,
  }
}

export async function createStatusReport(
  input: unknown,
  dependencies: StatusReportsDependencies = {}
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const now = dependencies.now?.() ?? new Date()
  const newId = dependencies.newId ?? (() => crypto.randomUUID())
  const parsed = parseOrThrow(createSchema, input)
  assertStatusMatchesType(parsed.type, parsed.update.status)
  assertNoIncidentWindow(parsed.type, parsed.endsAt)
  assertAffectedMatchesType(parsed.type, parsed.affected ?? [])

  // Validate against the EFFECTIVE startsAt (the explicit value, or the `now`
  // default applied below). An omitted startsAt must not let an endsAt in
  // the past slip past validation and persist an inverted window.
  const effectiveStartsAt = parsed.startsAt ?? now
  if (parsed.endsAt && parsed.endsAt.getTime() <= effectiveStartsAt.getTime()) {
    throw new StatusReportError(
      "VALIDATION_ERROR",
      "endsAt must be after startsAt",
      {
        startsAt: effectiveStartsAt.toISOString(),
        endsAt: parsed.endsAt.toISOString(),
      }
    )
  }

  const reportId = dependencies.reportId ?? newId()
  const update: StatusReportUpdateRow = {
    id: newId(),
    reportId,
    status: parsed.update.status,
    markdown: parsed.update.markdown,
    publishedAt: parsed.update.publishedAt ?? now,
    createdAt: now,
    updatedAt: now,
  }
  const report: StatusReportRow = {
    id: reportId,
    type: parsed.type,
    title: parsed.title,
    startsAt: effectiveStartsAt,
    endsAt: parsed.endsAt ?? null,
    publishedAt: parsed.draft === true ? null : now,
    resolvedAt: deriveResolvedAt([update]),
    originIncidentId: null,
    createdAt: now,
    updatedAt: now,
  }
  const affected = await snapshotAffected(
    store,
    reportId,
    parsed.affected ?? []
  )
  await store.insertReport({ report, update, affected })
  return serializeReport(report, [update], affected)
}

export async function updateStatusReport(
  id: string,
  input: unknown,
  dependencies: StatusReportsDependencies = {}
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const now = dependencies.now?.() ?? new Date()
  const parsed = parseOrThrow(patchSchema, input)
  // Window invariants, type/impact checks, and affected monitor resolution
  // all run inside the store's SELECT FOR UPDATE transaction against the
  // locked row. An earlier unlocked getReport is not authority for the
  // effective startsAt/endsAt merge (concurrent bound patches would race).
  const patch: { title?: string; startsAt?: Date; endsAt?: Date | null } = {}
  if (parsed.title !== undefined) {
    patch.title = parsed.title
  }
  if (parsed.startsAt !== undefined) {
    patch.startsAt = parsed.startsAt
  }
  if (parsed.endsAt !== undefined) {
    patch.endsAt = parsed.endsAt
  }
  const report = await store.updateReport({
    id,
    patch,
    affectedEntries: parsed.affected,
    now,
  })
  if (!report) {
    throw new StatusReportError(
      "REPORT_NOT_FOUND",
      "Status report was not found"
    )
  }
  return loadReportData(store, report)
}

/**
 * Cursor-paginated timeline for one report. Descending (publishedAt, createdAt,
 * id), default limit 50, max 100 via pageLimit at the route.
 */
export async function listStatusReportUpdates(
  reportId: string,
  input: { cursor: string | null; limit: number },
  dependencies: StatusReportsDependencies = {}
): Promise<{ data: StatusReportUpdateData[]; nextCursor: string | null }> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const existing = await store.getReport(reportId)
  if (!existing) {
    throw new StatusReportError(
      "REPORT_NOT_FOUND",
      "Status report was not found"
    )
  }
  const decoded = decodeReportUpdateCursor(input.cursor)
  if (!decoded.ok) {
    throw new StatusReportError("INVALID_CURSOR", "Cursor is invalid")
  }
  const cursor = decoded.cursor
    ? {
        publishedAt: new Date(decoded.cursor.publishedAt),
        createdAt: new Date(decoded.cursor.createdAt),
        id: decoded.cursor.id,
      }
    : null
  const rows = await store.listReportUpdates({
    reportId,
    cursor,
    limit: input.limit + 1,
  })
  const page = rows.slice(0, input.limit)
  const last = page.at(-1)
  return {
    data: page.map(serializeUpdateRow),
    nextCursor:
      rows.length > input.limit && last
        ? encodeReportUpdateCursor({
            publishedAt: last.publishedAt.toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  }
}

export async function deleteStatusReport(
  id: string,
  dependencies: StatusReportsDependencies = {}
): Promise<{ id: string }> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const deleted = await store.deleteReport(id)
  if (!deleted) {
    throw new StatusReportError(
      "REPORT_NOT_FOUND",
      "Status report was not found"
    )
  }
  return { id }
}

/**
 * Shared tail of the update mutations: recompute+persist the resolution
 * under the report-row lock (with the affected rows in parallel), and build
 * the response from the rows already in hand rather than a trailing
 * requireStatusReport re-fetch, keeping each mutation to at most 4 sequential
 * round-trips.
 */
async function persistResolutionAndSerialize(
  store: StatusReportsStore,
  report: StatusReportRow,
  now: Date
): Promise<StatusReportData> {
  const [recomputed, affected] = await Promise.all([
    store.recomputeResolution({ reportId: report.id, now }),
    store.getAffected([report.id]),
  ])
  if (!recomputed) {
    throw new StatusReportError(
      "REPORT_NOT_FOUND",
      "Status report was not found"
    )
  }
  return serializeReport(
    { ...report, resolvedAt: recomputed.resolvedAt, updatedAt: now },
    recomputed.updates,
    affected
  )
}

export async function addReportUpdate(
  reportId: string,
  input: unknown,
  dependencies: StatusReportsDependencies = {}
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const now = dependencies.now?.() ?? new Date()
  const newId = dependencies.newId ?? (() => crypto.randomUUID())
  const parsed = parseOrThrow(updateCreateSchema, input)
  const existing = await store.getReport(reportId)
  if (!existing) {
    throw new StatusReportError(
      "REPORT_NOT_FOUND",
      "Status report was not found"
    )
  }
  assertStatusMatchesType(existing.type, parsed.status)

  const update: StatusReportUpdateRow = {
    id: dependencies.updateId ?? newId(),
    reportId,
    status: parsed.status,
    markdown: parsed.markdown,
    publishedAt: parsed.publishedAt ?? now,
    createdAt: now,
    updatedAt: now,
  }
  // Row-locked insert: closes the race where a concurrent DELETE commits
  // between the existence check above and the insert. A report deleted in
  // that window must be re-detected here, inside the lock, as
  // REPORT_NOT_FOUND, never let the insert crash against a
  // gone-but-still-referenced report_id as a raw foreign-key-violation 500.
  const report = await store.insertReportUpdate({ reportId, update })
  if (!report) {
    throw new StatusReportError(
      "REPORT_NOT_FOUND",
      "Status report was not found"
    )
  }
  return persistResolutionAndSerialize(store, report, now)
}

export async function editReportUpdate(
  reportId: string,
  updateId: string,
  input: unknown,
  dependencies: StatusReportsDependencies = {}
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const now = dependencies.now?.() ?? new Date()
  const parsed = parseOrThrow(updateEditSchema, input)
  const report = await store.getReport(reportId)
  if (!report) {
    throw new StatusReportError(
      "REPORT_NOT_FOUND",
      "Status report was not found"
    )
  }
  if (parsed.status !== undefined) {
    assertStatusMatchesType(report.type, parsed.status)
  }

  const edited = await store.editUpdate({
    reportId,
    updateId,
    patch: parsed,
    now,
  })
  if (!edited) {
    throw new StatusReportError(
      "UPDATE_NOT_FOUND",
      "Report update was not found"
    )
  }
  return persistResolutionAndSerialize(store, report, now)
}

export async function deleteReportUpdate(
  reportId: string,
  updateId: string,
  dependencies: StatusReportsDependencies = {}
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const now = dependencies.now?.() ?? new Date()
  const report = await store.getReport(reportId)
  if (!report) {
    throw new StatusReportError(
      "REPORT_NOT_FOUND",
      "Status report was not found"
    )
  }
  // The store enforces the LAST_UPDATE invariant transactionally: the report
  // row is locked before the surviving count is read, so two concurrent
  // deletes cannot both observe "another update still exists" and race a
  // report down to zero updates.
  const outcome = await store.deleteUpdate({ reportId, updateId })
  if (outcome === "missing") {
    throw new StatusReportError(
      "UPDATE_NOT_FOUND",
      "Report update was not found"
    )
  }
  if (outcome === "last_update") {
    throw new StatusReportError(
      "LAST_UPDATE",
      "A report must keep at least one update; delete the report instead"
    )
  }
  return persistResolutionAndSerialize(store, report, now)
}

export async function publishStatusReport(
  id: string,
  dependencies: StatusReportsDependencies = {}
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const now = dependencies.now?.() ?? new Date()
  const outcome = await store.publishReport({ id, now })
  if (outcome === "missing") {
    throw new StatusReportError(
      "REPORT_NOT_FOUND",
      "Status report was not found"
    )
  }
  if (outcome === "already_published") {
    throw new StatusReportError(
      "ALREADY_PUBLISHED",
      "The status report is already published"
    )
  }
  return requireStatusReport(id, dependencies)
}

/** Matches the public label in lib/reporting/queries/status.ts (failureLabel). */
export function publicIncidentCause(openingStatusCode: number | null): string {
  return openingStatusCode === null
    ? "Availability check failed"
    : `HTTP ${openingStatusCode}`
}

/**
 * Prefills a DRAFT report from an auto-incident. Idempotent via the partial
 * unique index on originIncidentId: promoting the same incident twice returns
 * the existing report, whichever caller won the insert race.
 */
export async function promoteIncident(
  incidentId: string,
  dependencies: StatusReportsDependencies = {}
): Promise<{ report: StatusReportData; created: boolean }> {
  const store = dependencies.store ?? databaseStatusReportsStore
  const now = dependencies.now?.() ?? new Date()
  const newId = dependencies.newId ?? (() => crypto.randomUUID())
  const incident = await store.findIncident(incidentId)
  if (!incident) {
    throw new StatusReportError("INCIDENT_NOT_FOUND", "Incident was not found")
  }

  const reportId = dependencies.reportId ?? newId()
  const cause = publicIncidentCause(incident.openingStatusCode)
  const update: StatusReportUpdateRow = {
    id: newId(),
    reportId,
    status: "investigating",
    markdown: `We are investigating an outage affecting ${incident.monitorName}. Initial signal: ${cause}.`,
    publishedAt: incident.openedAt,
    createdAt: now,
    updatedAt: now,
  }
  const report: StatusReportRow = {
    id: reportId,
    type: "incident",
    title: `${incident.monitorName} outage`.slice(0, 160),
    startsAt: incident.openedAt,
    endsAt: null,
    publishedAt: null,
    resolvedAt: null,
    originIncidentId: incident.id,
    createdAt: now,
    updatedAt: now,
  }
  const affected: StatusReportAffectedRow[] = [
    {
      reportId,
      monitorId: incident.monitorId,
      monitorName: incident.monitorName,
      groupName: incident.groupName,
      impact: "down",
    },
  ]
  const outcome = await store.insertPromotedReport({ report, update, affected })
  if (outcome.created) {
    return {
      report: serializeReport(report, [update], affected),
      created: true,
    }
  }
  return {
    report: await requireStatusReport(outcome.id, dependencies),
    created: false,
  }
}

export type PublicReportPhase =
  | "ongoing"
  | "upcoming"
  | "window_ended"
  | "resolved"

export interface PublicStatusReport {
  id: string
  type: StatusReportType
  title: string
  startsAt: string
  endsAt: string | null
  publishedAt: string
  resolvedAt: string | null
  originIncidentId: string | null
  currentStatus: StatusReportUpdateStatus
  phase: PublicReportPhase
  latestUpdate: StatusReportUpdateData | null
  affected: AffectedServiceData[]
}

export interface PublicReports {
  ongoing: PublicStatusReport[]
  upcoming: PublicStatusReport[]
  windowEnded: PublicStatusReport[]
  resolved: PublicStatusReport[]
}

export const PUBLIC_RESOLVED_LIMIT = 10

/**
 * Group-page scoping: a report matches iff it affects a monitor in the
 * group, by live monitor id or by the SLUG of the snapshotted group name
 * (mirrors filterReportsForGroupSlug in lib/reporting/queries/status.ts).
 * Passed through to getPublicReportRows so the unresolved and resolved
 * LIMITs are applied AFTER group scoping, not before. Otherwise a global
 * top-10 can starve a group's history even though older relevant resolved
 * reports exist. Callers hand over the URL slug, never live group names: a
 * raw-name comparison would drop a report whose snapshot spells the group
 * differently (accents, case, punctuation) than the live monitors do even
 * though both collapse to the same slug, and an archived-only group has no
 * live names to compare at all.
 */
export interface PublicReportsFilter {
  monitorIds: readonly string[]
  groupSlug: string
}

/**
 * Store-level prefilter with the slug already resolved to the exact
 * snapshotted group names it matches, so the store can compare raw strings.
 */
export interface PublicReportRowsFilter {
  monitorIds: readonly string[]
  groupNames: readonly string[]
}

/**
 * Lifecycle rules: upcoming = published ∧ startsAt > now, for EITHER
 * report type, since a future-dated report of any kind hasn't started yet.
 * Ongoing = published ∧ startsAt ≤ now ∧ not completed. A maintenance window
 * past endsAt with no completing update is demoted to "window_ended".
 *
 * The latest update's status must never move a started window back to
 * "upcoming": a started, non-completed window is ongoing regardless of
 * whether anyone posted an in_progress update, so this must agree with the
 * SQL active-bucket ranking in getPublicReportRows, which ranks a started
 * window as active independent of the operator having posted anything.
 */
export function classifyPublicReport(
  report: Pick<StatusReportRow, "type" | "startsAt" | "endsAt" | "resolvedAt">,
  now: Date
): PublicReportPhase {
  if (report.resolvedAt) {
    return "resolved"
  }
  if (report.startsAt.getTime() > now.getTime()) {
    return "upcoming"
  }
  if (
    report.type === "maintenance" &&
    report.endsAt &&
    report.endsAt.getTime() <= now.getTime()
  ) {
    return "window_ended"
  }
  return "ongoing"
}

// Route params reach the store verbatim. A non-UUID value would make Postgres
// raise 22P02 on the uuid comparison (a 500) instead of a clean 404, so isUuid
// (imported from lib/ids/uuid) gates every id read below. Mirrors
// lib/api/images.ts.

const reportSelection = {
  id: statusReports.id,
  type: statusReports.type,
  title: statusReports.title,
  startsAt: statusReports.startsAt,
  endsAt: statusReports.endsAt,
  publishedAt: statusReports.publishedAt,
  resolvedAt: statusReports.resolvedAt,
  originIncidentId: statusReports.originIncidentId,
  createdAt: statusReports.createdAt,
  updatedAt: statusReports.updatedAt,
}

const updateSelection = {
  id: statusReportUpdates.id,
  reportId: statusReportUpdates.reportId,
  status: statusReportUpdates.status,
  markdown: statusReportUpdates.markdown,
  publishedAt: statusReportUpdates.publishedAt,
  createdAt: statusReportUpdates.createdAt,
  updatedAt: statusReportUpdates.updatedAt,
}

const affectedSelection = {
  reportId: statusReportAffected.reportId,
  monitorId: statusReportAffected.monitorId,
  monitorName: statusReportAffected.monitorName,
  groupName: statusReportAffected.groupName,
  impact: statusReportAffected.impact,
}

/**
 * Store factory closing over a DatabaseHandle: a plain Database connection
 * for read paths, or a transaction handle when a route wants every store
 * call (and the FOR UPDATE locks below) to nest inside its own outer
 * transaction as savepoints. `handle.transaction` opens a top-level
 * transaction when `handle` is the database, or a savepoint when `handle`
 * is already a transaction.
 */
export function createDatabaseStatusReportsStore(
  handle: DatabaseHandle
): StatusReportsStore {
  return {
    async findMonitors(ids) {
      if (ids.length === 0) {
        return []
      }
      return handle
        .select({
          id: monitorRegistry.id,
          name: monitorRegistry.name,
          groupName: monitorRegistry.groupName,
        })
        .from(monitorRegistry)
        .where(inArray(monitorRegistry.id, [...ids]))
    },

    async insertReport({ report, update, affected }) {
      await handle.transaction(async (tx) => {
        await tx.insert(statusReports).values(report)
        await tx.insert(statusReportUpdates).values(update)
        if (affected.length > 0) {
          await tx.insert(statusReportAffected).values(affected)
        }
      })
    },

    async insertPromotedReport({ report, update, affected }) {
      return handle.transaction(async (tx) => {
        const inserted = await tx
          .insert(statusReports)
          .values(report)
          .onConflictDoNothing({
            target: statusReports.originIncidentId,
            where: sql`${statusReports.originIncidentId} is not null`,
          })
          .returning({ id: statusReports.id })
        if (!inserted[0]) {
          const [existing] = await tx
            .select({ id: statusReports.id })
            .from(statusReports)
            .where(eq(statusReports.originIncidentId, report.originIncidentId!))
            .limit(1)
          if (!existing) {
            throw new Error("Promotion conflict without an existing report")
          }
          return { id: existing.id, created: false }
        }
        await tx.insert(statusReportUpdates).values(update)
        if (affected.length > 0) {
          await tx.insert(statusReportAffected).values(affected)
        }
        return { id: report.id, created: true }
      })
    },

    async getReport(id) {
      if (!isUuid(id)) {
        return null
      }
      const [row] = await handle
        .select(reportSelection)
        .from(statusReports)
        .where(eq(statusReports.id, id))
        .limit(1)
      return row ?? null
    },

    async listReports({ state, type, cursor, limit }) {
      const conditions: SQL[] = []
      if (state === "draft") {
        conditions.push(isNull(statusReports.publishedAt))
      }
      if (state === "ongoing") {
        conditions.push(
          isNotNull(statusReports.publishedAt),
          isNull(statusReports.resolvedAt)
        )
      }
      if (state === "resolved") {
        conditions.push(
          isNotNull(statusReports.publishedAt),
          isNotNull(statusReports.resolvedAt)
        )
      }
      if (type !== "all") {
        conditions.push(eq(statusReports.type, type))
      }
      if (cursor) {
        conditions.push(
          or(
            lt(statusReports.createdAt, cursor.createdAt),
            and(
              eq(statusReports.createdAt, cursor.createdAt),
              lt(statusReports.id, cursor.id)
            )
          )!
        )
      }
      return handle
        .select(reportSelection)
        .from(statusReports)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(statusReports.createdAt), desc(statusReports.id))
        .limit(limit + 1)
    },

    async getReportDetails(ids) {
      if (ids.length === 0) {
        return { updates: [], counts: [], affected: [] }
      }
      // Per-report bound: a window rank partitioned by report keeps the newest
      // DETAIL_UPDATES_PAGE_SIZE updates for EVERY requested report, so one
      // chatty report can never starve the others out of a shared global cap.
      // Older pages load via listReportUpdates. No outer ORDER BY;
      // serializeReport re-sorts per report in JS anyway.
      const ranked = handle.$with("ranked_updates").as(
        handle
          .select({
            ...updateSelection,
            updateRank:
              sql<number>`row_number() over (partition by ${statusReportUpdates.reportId} order by ${statusReportUpdates.publishedAt} desc, ${statusReportUpdates.createdAt} desc, ${statusReportUpdates.id} desc)`.as(
                "update_rank"
              ),
          })
          .from(statusReportUpdates)
          .where(inArray(statusReportUpdates.reportId, [...ids]))
      )
      const [updates, counts, affected] = await Promise.all([
        handle
          .with(ranked)
          .select({
            id: ranked.id,
            reportId: ranked.reportId,
            status: ranked.status,
            markdown: ranked.markdown,
            publishedAt: ranked.publishedAt,
            createdAt: ranked.createdAt,
            updatedAt: ranked.updatedAt,
          })
          .from(ranked)
          .where(lte(ranked.updateRank, DETAIL_UPDATES_PAGE_SIZE)),
        handle
          .select({ reportId: statusReportUpdates.reportId, count: count() })
          .from(statusReportUpdates)
          .where(inArray(statusReportUpdates.reportId, [...ids]))
          .groupBy(statusReportUpdates.reportId),
        // Bound derived from the requested reports, not an arbitrary constant:
        // each report can hold at most MAX_AFFECTED_PER_REPORT rows (enforced at
        // write time), so this cap can never truncate a page of reports that
        // are each individually within bounds.
        handle
          .select(affectedSelection)
          .from(statusReportAffected)
          .where(inArray(statusReportAffected.reportId, [...ids]))
          .limit(ids.length * MAX_AFFECTED_PER_REPORT),
      ])
      return { updates, counts, affected }
    },

    async listReportUpdates({ reportId, cursor, limit }) {
      if (!isUuid(reportId)) {
        return []
      }
      const conditions: SQL[] = [eq(statusReportUpdates.reportId, reportId)]
      if (cursor) {
        // Exclusive upper bound in descending (publishedAt, createdAt, id).
        conditions.push(
          or(
            lt(statusReportUpdates.publishedAt, cursor.publishedAt),
            and(
              eq(statusReportUpdates.publishedAt, cursor.publishedAt),
              lt(statusReportUpdates.createdAt, cursor.createdAt)
            ),
            and(
              eq(statusReportUpdates.publishedAt, cursor.publishedAt),
              eq(statusReportUpdates.createdAt, cursor.createdAt),
              lt(statusReportUpdates.id, cursor.id)
            )
          )!
        )
      }
      return handle
        .select(updateSelection)
        .from(statusReportUpdates)
        .where(and(...conditions))
        .orderBy(
          desc(statusReportUpdates.publishedAt),
          desc(statusReportUpdates.createdAt),
          desc(statusReportUpdates.id)
        )
        .limit(limit)
    },

    async getListDetails(ids) {
      if (ids.length === 0) {
        return { counts: [], latest: [], affected: [] }
      }
      const [counts, latest, affected] = await Promise.all([
        handle
          .select({ reportId: statusReportUpdates.reportId, count: count() })
          .from(statusReportUpdates)
          .where(inArray(statusReportUpdates.reportId, [...ids]))
          .groupBy(statusReportUpdates.reportId),
        handle
          .selectDistinctOn([statusReportUpdates.reportId], {
            reportId: statusReportUpdates.reportId,
            status: statusReportUpdates.status,
            publishedAt: statusReportUpdates.publishedAt,
          })
          .from(statusReportUpdates)
          .where(inArray(statusReportUpdates.reportId, [...ids]))
          .orderBy(
            statusReportUpdates.reportId,
            desc(statusReportUpdates.publishedAt),
            desc(statusReportUpdates.createdAt),
            desc(statusReportUpdates.id)
          ),
        handle
          .select(affectedSelection)
          .from(statusReportAffected)
          .where(inArray(statusReportAffected.reportId, [...ids]))
          .limit(ids.length * MAX_AFFECTED_PER_REPORT),
      ])
      return { counts, latest, affected }
    },

    async updateReport({ id, patch, affectedEntries, now }) {
      if (!isUuid(id)) {
        return null
      }
      // SELECT FOR UPDATE so concurrent start/end patches serialize: each
      // merges against the locked row, validates the effective window, then
      // writes. An unlocked pre-read cannot be authority for the merge.
      return handle.transaction(async (tx) => {
        const [locked] = await tx
          .select(reportSelection)
          .from(statusReports)
          .where(eq(statusReports.id, id))
          .for("update")
        if (!locked) {
          return null
        }
        // Only the CALLER'S endsAt is checked for the incident-window ban: a
        // title-only patch must not fail on pre-existing data.
        assertNoIncidentWindow(locked.type, patch.endsAt)
        if (affectedEntries !== undefined) {
          assertAffectedMatchesType(locked.type, affectedEntries)
        }
        const effectiveStartsAt = patch.startsAt ?? locked.startsAt
        const effectiveEndsAt =
          patch.endsAt === undefined ? locked.endsAt : patch.endsAt
        if (
          effectiveEndsAt &&
          effectiveEndsAt.getTime() <= effectiveStartsAt.getTime()
        ) {
          throw new StatusReportError(
            "VALIDATION_ERROR",
            "endsAt must be after startsAt",
            {
              startsAt: effectiveStartsAt.toISOString(),
              endsAt: effectiveEndsAt.toISOString(),
            }
          )
        }

        let resolvedAffected: StatusReportAffectedRow[] | undefined
        if (affectedEntries !== undefined) {
          // Resolve monitors inside the same transaction as the window merge.
          if (affectedEntries.length === 0) {
            resolvedAffected = []
          } else {
            const monitors = await tx
              .select({
                id: monitorRegistry.id,
                name: monitorRegistry.name,
                groupName: monitorRegistry.groupName,
              })
              .from(monitorRegistry)
              .where(
                inArray(
                  monitorRegistry.id,
                  affectedEntries.map((entry) => entry.monitorId)
                )
              )
            const byId = new Map(
              monitors.map((monitor) => [monitor.id, monitor])
            )
            resolvedAffected = affectedEntries.map((entry) => {
              const monitor = byId.get(entry.monitorId)
              if (!monitor) {
                throw new StatusReportError(
                  "VALIDATION_ERROR",
                  `Affected monitor "${entry.monitorId}" was not found`,
                  { monitorId: entry.monitorId }
                )
              }
              return {
                reportId: id,
                monitorId: monitor.id,
                monitorName: monitor.name,
                groupName: monitor.groupName,
                impact: entry.impact,
              }
            })
          }
        }

        const [row] = await tx
          .update(statusReports)
          .set({ ...patch, updatedAt: now })
          .where(eq(statusReports.id, id))
          .returning(reportSelection)
        if (!row) {
          return null
        }
        if (resolvedAffected !== undefined) {
          await tx
            .delete(statusReportAffected)
            .where(eq(statusReportAffected.reportId, id))
          if (resolvedAffected.length > 0) {
            await tx.insert(statusReportAffected).values(resolvedAffected)
          }
        }
        return row
      })
    },

    async deleteReport(id) {
      if (!isUuid(id)) {
        return false
      }
      const rows = await handle
        .delete(statusReports)
        .where(eq(statusReports.id, id))
        .returning({ id: statusReports.id })
      return rows.length > 0
    },

    async insertUpdate(row) {
      await handle.insert(statusReportUpdates).values(row)
    },

    async insertReportUpdate({ reportId, update }) {
      if (!isUuid(reportId)) {
        return null
      }
      // `SELECT ... FOR UPDATE` on the report serializes against a concurrent
      // DELETE on the SAME row (mirrors deleteUpdate/recomputeResolution): a
      // racing delete either commits first (the lock then finds zero rows,
      // so this returns null before ever attempting the insert), or blocks
      // behind this transaction, closing the window where an unguarded insert
      // could hit the report_id foreign key after the row was already gone.
      return handle.transaction(async (tx) => {
        const [locked] = await tx
          .select(reportSelection)
          .from(statusReports)
          .where(eq(statusReports.id, reportId))
          .for("update")
        if (!locked) {
          return null
        }
        await tx.insert(statusReportUpdates).values(update)
        return locked
      })
    },

    async editUpdate({ reportId, updateId, patch, now }) {
      if (!(isUuid(reportId) && isUuid(updateId))) {
        return null
      }
      // Row-locked transaction: `SELECT ... FOR UPDATE` on the report first,
      // mirroring deleteUpdate/recomputeResolution, so every mutation that
      // touches a report's updates takes the report lock in the SAME order.
      // Without this, a concurrent report DELETE (which locks the report row
      // then cascades to update rows) could lock in the opposite order and
      // deadlock against this UPDATE plus recomputeResolution's later lock.
      return handle.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: statusReports.id })
          .from(statusReports)
          .where(eq(statusReports.id, reportId))
          .for("update")
        if (!locked) {
          return null
        }
        const [row] = await tx
          .update(statusReportUpdates)
          .set({ ...patch, updatedAt: now })
          .where(
            and(
              eq(statusReportUpdates.id, updateId),
              eq(statusReportUpdates.reportId, reportId)
            )
          )
          .returning(updateSelection)
        return row ?? null
      })
    },

    async deleteUpdate({ reportId, updateId }) {
      if (!(isUuid(reportId) && isUuid(updateId))) {
        return "missing"
      }
      // Row-locked transaction: `SELECT ... FOR UPDATE` on the report serializes
      // concurrent deletes for the SAME report (Postgres row locks are per-row,
      // so unrelated reports never contend). The unlocked count subquery this
      // replaced let two concurrent deletes of DIFFERENT updates on a
      // two-update report both observe count=2 under READ COMMITTED and both
      // succeed, leaving zero updates. The lock forces the second transaction
      // to wait and re-observe the post-delete count.
      return handle.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: statusReports.id })
          .from(statusReports)
          .where(eq(statusReports.id, reportId))
          .for("update")
        if (!locked) {
          return "missing"
        }
        const [existing] = await tx
          .select({ id: statusReportUpdates.id })
          .from(statusReportUpdates)
          .where(
            and(
              eq(statusReportUpdates.id, updateId),
              eq(statusReportUpdates.reportId, reportId)
            )
          )
          .limit(1)
        if (!existing) {
          return "missing"
        }
        const [totals] = await tx
          .select({ total: count() })
          .from(statusReportUpdates)
          .where(eq(statusReportUpdates.reportId, reportId))
        if (!totals || totals.total <= 1) {
          return "last_update"
        }
        await tx
          .delete(statusReportUpdates)
          .where(
            and(
              eq(statusReportUpdates.id, updateId),
              eq(statusReportUpdates.reportId, reportId)
            )
          )
        return "deleted"
      })
    },

    async recomputeResolution({ reportId, now }) {
      if (!isUuid(reportId)) {
        return null
      }
      // Row-locked transaction: `SELECT ... FOR UPDATE` on the report serializes
      // concurrent recomputes for the SAME report, mirroring deleteUpdate's
      // guard. Without the lock, two mutations racing on the same report could
      // each list-then-derive from a snapshot taken before the OTHER's write
      // committed, and whichever's UPDATE lands last would persist a stale
      // resolvedAt over the correct one: a lost-update race. The lock forces
      // the second transaction to wait and re-read the post-write state.
      return handle.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: statusReports.id })
          .from(statusReports)
          .where(eq(statusReports.id, reportId))
          .for("update")
        if (!locked) {
          return null
        }
        // Ordered by the contract total order with the cap taking the NEWEST
        // rows, so a capped read can never drop the update that decides
        // resolvedAt.
        const updates = await tx
          .select(updateSelection)
          .from(statusReportUpdates)
          .where(eq(statusReportUpdates.reportId, reportId))
          .orderBy(
            desc(statusReportUpdates.publishedAt),
            desc(statusReportUpdates.createdAt),
            desc(statusReportUpdates.id)
          )
          .limit(1000)
        const resolvedAt = deriveResolvedAt(updates)
        await tx
          .update(statusReports)
          .set({ resolvedAt, updatedAt: now })
          .where(eq(statusReports.id, reportId))
        return { updates, resolvedAt }
      })
    },

    async publishReport({ id, now }) {
      if (!isUuid(id)) {
        return "missing"
      }
      const rows = await handle
        .update(statusReports)
        .set({ publishedAt: now, updatedAt: now })
        .where(and(eq(statusReports.id, id), isNull(statusReports.publishedAt)))
        .returning({ id: statusReports.id })
      if (rows.length > 0) {
        return "published"
      }
      const [existing] = await handle
        .select({ id: statusReports.id })
        .from(statusReports)
        .where(eq(statusReports.id, id))
        .limit(1)
      return existing ? "already_published" : "missing"
    },

    async findIncident(incidentId) {
      if (!isUuid(incidentId)) {
        return null
      }
      const [row] = await handle
        .select({
          id: incidents.id,
          monitorId: incidents.monitorId,
          monitorName: monitorRegistry.name,
          groupName: monitorRegistry.groupName,
          openedAt: incidents.openedAt,
          openingStatusCode: incidents.openingStatusCode,
        })
        .from(incidents)
        .innerJoin(monitorRegistry, eq(monitorRegistry.id, incidents.monitorId))
        // First-run gate. An incident opened before its monitor activated is a
        // setup-phase failure, so joining monitor_state and requiring openedAt
        // at or after activatedAt keeps promotion from turning it into a public
        // report. The excluded row reads as not found, matching promoteIncident's
        // INCIDENT_NOT_FOUND path. A null activatedAt fails the comparison, and a
        // genuine ongoing incident is kept since the backfill sets activatedAt at
        // or before its openedAt.
        .innerJoin(
          monitorState,
          eq(monitorState.monitorId, incidents.monitorId)
        )
        .where(
          and(
            eq(incidents.id, incidentId),
            gte(incidents.openedAt, monitorState.activatedAt)
          )
        )
        .limit(1)
      return row ?? null
    },

    async getAffectedGroupNames() {
      // Distinct snapshot names are bounded by the number of group names ever
      // used across published reports, far below this cap in any real
      // deployment (the registry itself caps at 100 live monitors). The LIMIT
      // only guards against a pathological table scan.
      const rows = await handle
        .selectDistinct({ groupName: statusReportAffected.groupName })
        .from(statusReportAffected)
        .limit(10_000)
      return rows.map((row) => row.groupName)
    },

    async getPublicReportRows({ resolvedLimit, now, filter }) {
      // group scoping: EXISTS against status_report_affected, matching either
      // a live monitor id or the row's snapshotted group name. The names
      // arrive pre-resolved from the page slug (see getPublicReports), so this
      // raw-string comparison is slug-exact. Rides the same 2 branches below,
      // no extra query.
      const groupScope = filter
        ? sql`exists (
            select 1 from ${statusReportAffected}
            where ${statusReportAffected.reportId} = ${statusReports.id}
              and (
                ${filter.monitorIds.length > 0 ? inArray(statusReportAffected.monitorId, [...filter.monitorIds]) : sql`false`}
                or ${filter.groupNames.length > 0 ? inArray(sql`coalesce(${statusReportAffected.groupName}, 'Other')`, [...filter.groupNames]) : sql`false`}
              )
          )`
        : undefined
      // One round-trip: the unresolved branch rides status_reports_ongoing
      // (partial on resolvedAt IS NULL) and the resolved branch the recency
      // sort. The unresolved branch ranks truly ACTIVE rows (started, not yet
      // ended) first, then future-scheduled rows, then ended-but-uncompleted
      // windows (a maintenance row whose endsAt already passed with no
      // completing update) last, so within the 100 cap neither 100+ future
      // maintenance windows nor a stale ended window can crowd out an active
      // report that would otherwise sort later by startsAt DESC alone.
      //
      // Within the future bucket the tiebreak is ASCENDING startsAt (nearest
      // upcoming first) rather than the DESC used elsewhere: a shared DESC
      // tiebreak would keep the FARTHEST-future rows inside the 100 cap,
      // starving the soonest upcoming report whenever 100+ future rows exist.
      // The CASE expression only produces a value for future rows, so it's a
      // no-op tiebreak for the active bucket, which still falls through to the
      // final `startsAt DESC` column.
      const unresolved = handle
        .select(reportSelection)
        .from(statusReports)
        .where(
          and(
            isNotNull(statusReports.publishedAt),
            isNull(statusReports.resolvedAt),
            ...(groupScope ? [groupScope] : [])
          )
        )
        .orderBy(
          sql`(${statusReports.endsAt} is not null and ${statusReports.endsAt} <= ${now.toISOString()})`,
          sql`(${statusReports.startsAt} > ${now.toISOString()})`,
          sql`(case when ${statusReports.startsAt} > ${now.toISOString()} then ${statusReports.startsAt} end) asc nulls last`,
          desc(statusReports.startsAt)
        )
        .limit(100)
      const resolved = handle
        .select(reportSelection)
        .from(statusReports)
        .where(
          and(
            isNotNull(statusReports.publishedAt),
            isNotNull(statusReports.resolvedAt),
            ...(groupScope ? [groupScope] : [])
          )
        )
        .orderBy(desc(statusReports.resolvedAt))
        .limit(resolvedLimit)
      return unionAll(unresolved, resolved)
    },

    async getLatestUpdates(reportIds) {
      if (reportIds.length === 0) {
        return []
      }
      return handle
        .selectDistinctOn([statusReportUpdates.reportId], updateSelection)
        .from(statusReportUpdates)
        .where(inArray(statusReportUpdates.reportId, [...reportIds]))
        .orderBy(
          statusReportUpdates.reportId,
          desc(statusReportUpdates.publishedAt),
          desc(statusReportUpdates.createdAt),
          desc(statusReportUpdates.id)
        )
    },

    async getAffected(reportIds) {
      if (reportIds.length === 0) {
        return []
      }
      // Bound derived from the requested reports (see getReportDetails): group
      // filtering and chips must never lose rows to an arbitrary global cap.
      return handle
        .select(affectedSelection)
        .from(statusReportAffected)
        .where(inArray(statusReportAffected.reportId, [...reportIds]))
        .limit(reportIds.length * MAX_AFFECTED_PER_REPORT)
    },
  }
}

/** Read paths and existing call sites use the shared default-database instance. */
export const databaseStatusReportsStore: StatusReportsStore =
  createDatabaseStatusReportsStore(db)
