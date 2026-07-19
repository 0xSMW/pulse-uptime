import "server-only";

import { and, count, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";

import { db } from "@/lib/db/client";
import {
  incidents,
  monitorRegistry,
  statusReportAffected,
  statusReports,
  statusReportUpdates,
  type statusReportImpacts,
  type statusReportTypes,
  type statusReportUpdateStatuses,
} from "@/lib/db/schema";
import { statusGroupSlug } from "@/lib/reporting/queries/timeline";

import { decodeCursor, encodeCursor } from "./pagination";

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

export type StatusReportType = (typeof statusReportTypes)[number];
export type StatusReportUpdateStatus = (typeof statusReportUpdateStatuses)[number];
export type StatusReportImpact = (typeof statusReportImpacts)[number];

export const INCIDENT_UPDATE_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export const MAINTENANCE_UPDATE_STATUSES = ["scheduled", "in_progress", "completed"] as const;
const RESOLVING_STATUSES: readonly StatusReportUpdateStatus[] = ["resolved", "completed"];

export type StatusReportRow = {
  id: string;
  type: StatusReportType;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  publishedAt: Date | null;
  resolvedAt: Date | null;
  originIncidentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StatusReportUpdateRow = {
  id: string;
  reportId: string;
  status: StatusReportUpdateStatus;
  markdown: string;
  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type StatusReportAffectedRow = {
  reportId: string;
  monitorId: string;
  monitorName: string;
  groupName: string | null;
  impact: StatusReportImpact;
};

export type StatusReportUpdateData = {
  id: string;
  status: StatusReportUpdateStatus;
  markdown: string;
  publishedAt: string;
  /**
   * RFC 3339. Serialized so clients can reproduce the exact server total
   * order (publishedAt, createdAt, id) for backdated-timestamp ties.
   */
  createdAt: string;
};

export type AffectedServiceData = {
  monitorId: string;
  monitorName: string;
  groupName: string | null;
  impact: StatusReportImpact;
};

export type StatusReportData = {
  id: string;
  type: StatusReportType;
  title: string;
  startsAt: string;
  endsAt: string | null;
  publishedAt: string | null;
  resolvedAt: string | null;
  originIncidentId: string | null;
  currentStatus: StatusReportUpdateStatus;
  updates: StatusReportUpdateData[];
  affected: AffectedServiceData[];
  createdAt: string;
  updatedAt: string;
};

/**
 * List-shaped row: everything a report list needs without the
 * markdown bodies or the full update timeline. `getStatusReport` keeps the
 * detailed shape.
 */
export type StatusReportListItemData = {
  id: string;
  type: StatusReportType;
  title: string;
  startsAt: string;
  endsAt: string | null;
  publishedAt: string | null;
  resolvedAt: string | null;
  originIncidentId: string | null;
  currentStatus: StatusReportUpdateStatus;
  updatesCount: number;
  latestUpdate: { status: StatusReportUpdateStatus; publishedAt: string } | null;
  affected: AffectedServiceData[];
  createdAt: string;
  updatedAt: string;
};

export type StatusReportListState = "all" | "draft" | "ongoing" | "resolved";
export type StatusReportListType = "all" | "incident" | "maintenance";

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
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StatusReportError";
  }
}

export interface StatusReportsStore {
  findMonitors(ids: readonly string[]): Promise<Array<{ id: string; name: string; groupName: string | null }>>;
  insertReport(input: {
    report: StatusReportRow;
    update: StatusReportUpdateRow;
    affected: StatusReportAffectedRow[];
  }): Promise<void>;
  /** Insert honoring the partial unique index on originIncidentId. */
  insertPromotedReport(input: {
    report: StatusReportRow;
    update: StatusReportUpdateRow;
    affected: StatusReportAffectedRow[];
  }): Promise<{ id: string; created: boolean }>;
  getReport(id: string): Promise<StatusReportRow | null>;
  listReports(input: {
    state: StatusReportListState;
    type: StatusReportListType;
    cursor: { createdAt: Date; id: string } | null;
    limit: number;
  }): Promise<StatusReportRow[]>;
  getReportDetails(ids: readonly string[]): Promise<{
    updates: StatusReportUpdateRow[];
    affected: StatusReportAffectedRow[];
  }>;
  /**
   * List-path details: per-report update counts + the latest update's status
   * and publishedAt (via the contract total order), never markdown bodies.
   */
  getListDetails(ids: readonly string[]): Promise<{
    counts: Array<{ reportId: string; count: number }>;
    latest: Array<{ reportId: string; status: StatusReportUpdateStatus; publishedAt: Date }>;
    affected: StatusReportAffectedRow[];
  }>;
  updateReport(input: {
    id: string;
    patch: { title?: string; startsAt?: Date; endsAt?: Date | null };
    affected: StatusReportAffectedRow[] | undefined;
    now: Date;
  }): Promise<StatusReportRow | null>;
  deleteReport(id: string): Promise<boolean>;
  insertUpdate(row: StatusReportUpdateRow): Promise<void>;
  /**
   * Row-locked insert for addReportUpdate: locks the report (`FOR UPDATE`,
   * mirroring deleteUpdate/recomputeResolution) and re-verifies it still
   * exists INSIDE the same transaction as the insert, closing the race
   * where a concurrent DELETE commits between an earlier existence check and
   * this insert, which must surface as REPORT_NOT_FOUND, never a raw
   * report_id foreign-key violation. Returns the locked report row, or null
   * if it no longer exists, in which case nothing is inserted.
   */
  insertReportUpdate(input: { reportId: string; update: StatusReportUpdateRow }): Promise<StatusReportRow | null>;
  editUpdate(input: {
    reportId: string;
    updateId: string;
    patch: { status?: StatusReportUpdateStatus; markdown?: string; publishedAt?: Date };
    now: Date;
  }): Promise<StatusReportUpdateRow | null>;
  /**
   * Transactional guarded delete: the report row is locked (`FOR UPDATE`) so
   * concurrent deletes on the same report serialize before the surviving
   * count is read, then the row is removed only while at least one other
   * update for the report exists. "last_update" = the row exists but is the
   * report's final update, "missing" = no such row.
   */
  deleteUpdate(input: { reportId: string; updateId: string }): Promise<"deleted" | "last_update" | "missing">;
  /**
   * Point lookup, never capped: recovery must find a backdated update even
   * when 500+ newer rows exist, unlike getReportDetails's capped scan.
   */
  getUpdate(reportId: string, updateId: string): Promise<StatusReportUpdateRow | null>;
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
  recomputeResolution(input: {
    reportId: string;
    now: Date;
  }): Promise<{ updates: StatusReportUpdateRow[]; resolvedAt: Date | null } | null>;
  publishReport(input: { id: string; now: Date }): Promise<"published" | "already_published" | "missing">;
  findIncident(incidentId: string): Promise<{
    id: string;
    monitorId: string;
    monitorName: string;
    groupName: string | null;
    openedAt: Date;
    openingStatusCode: number | null;
  } | null>;
  /** Query 1 of getPublicReports: published ongoing/upcoming + recent resolved. */
  getPublicReportRows(input: {
    resolvedLimit: number;
    now: Date;
    filter?: PublicReportRowsFilter;
  }): Promise<StatusReportRow[]>;
  /**
   * Distinct group names ever snapshotted into affected rows, null included.
   * Backs slug scoping in getPublicReports: statusGroupSlug cannot be
   * reproduced faithfully in SQL (NFKD normalization, diacritics), so the
   * service enumerates the snapshot names, slugs them in JS, and hands the
   * exact matching names to getPublicReportRows for raw-string comparison.
   */
  getAffectedGroupNames(): Promise<Array<string | null>>;
  /** Query 2: latest update per report via DISTINCT ON, total-order aligned. */
  getLatestUpdates(reportIds: readonly string[]): Promise<StatusReportUpdateRow[]>;
  /** Query 3: affected rows for the page of reports. */
  getAffected(reportIds: readonly string[]): Promise<StatusReportAffectedRow[]>;
  /**
   * Point lookup by the partial unique index on originIncidentId, backing
   * promote's idempotency recovery: is there already a report for this
   * incident?
   */
  getReportByOriginIncident(incidentId: string): Promise<StatusReportRow | null>;
}

export type StatusReportsDependencies = {
  store?: StatusReportsStore;
  now?: () => Date;
  newId?: () => string;
  /**
   * Pins createStatusReport's (or promoteIncident's) report id instead of
   * drawing one from newId(). The POST route sets this to the idempotency
   * operationId so a retry after a crash mid-request can recover the row by
   * id rather than re-running the callback with a fresh random id and
   * creating a duplicate report.
   */
  reportId?: string;
  /** Same idea as reportId, for addReportUpdate's new update row. */
  updateId?: string;
};

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

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
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const epochMs = Date.parse(value);
  if (Number.isNaN(epochMs)) return false;
  const offset = match[7]!;
  const offsetMinutes = offset === "Z" || offset === "z"
    ? 0
    : (offset.startsWith("-") ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  // Shifting the UTC instant by the written offset reconstructs the caller's
  // wall-clock components, so getUTC* reads them back for comparison.
  const wallClock = new Date(epochMs + offsetMinutes * 60_000);
  return (
    wallClock.getUTCFullYear() === Number(match[1])
    && wallClock.getUTCMonth() + 1 === Number(match[2])
    && wallClock.getUTCDate() === Number(match[3])
    && wallClock.getUTCHours() === Number(match[4])
    && wallClock.getUTCMinutes() === Number(match[5])
    && wallClock.getUTCSeconds() === Number(match[6])
  );
}

const timestampSchema = z
  .string()
  .refine(isStrictRfc3339, { message: "Must be an RFC 3339 timestamp" })
  .transform((value) => new Date(value));

export const MAX_MARKDOWN_LENGTH = 10_240;

const titleSchema = z.string().trim().min(1, "Title is required").max(160, "Title must be at most 160 characters");
const markdownSchema = z
  .string()
  .max(MAX_MARKDOWN_LENGTH, "Update body must be at most 10 KB")
  .refine((value) => value.trim().length > 0, { message: "Update body is required" });

const updateStatusSchema = z.enum([...INCIDENT_UPDATE_STATUSES, ...MAINTENANCE_UPDATE_STATUSES]);

const affectedEntrySchema = z
  .object({
    monitorId: z.string().trim().min(1),
    impact: z.enum(["down", "degraded", "maintenance"]),
  })
  .strict();

/**
 * Per-report cap on affected monitors, enforced both at the input schema and
 * as the multiplier the affected-row read caps derive from (reportIds.length
 * * MAX_AFFECTED_PER_REPORT) so a global cap can never truncate a page of
 * reports that are each individually within bounds.
 */
export const MAX_AFFECTED_PER_REPORT = 100;

const affectedListSchema = z
  .array(affectedEntrySchema)
  .max(MAX_AFFECTED_PER_REPORT)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.monitorId)).size === entries.length,
    { message: "Affected monitors must be unique" },
  );

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
  .strict();

const patchSchema = z
  .object({
    title: titleSchema.optional(),
    startsAt: timestampSchema.optional(),
    endsAt: timestampSchema.nullable().optional(),
    affected: affectedListSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field to update" });

export type StatusReportPatchInput = z.infer<typeof patchSchema>;

/**
 * Parses `body` against the SAME patchSchema updateStatusReport uses,
 * returning the normalized result (title trimmed, affected.monitorId
 * trimmed, timestamps coerced to Date) or null if invalid.
 *
 * Exported so idempotency recovery (statusReportPatchAlreadyApplied in
 * lib/api/status-report-http.ts) can compare the caller's patch against the
 * CURRENT report using the same normalized values the real patch persists:
 * comparing raw, un-parsed request fields would miss that title and
 * affected.monitorId are trimmed by this schema, and so would spuriously
 * fail recovery for a request whose raw field still carries whitespace.
 */
export function parseStatusReportPatch(body: unknown): StatusReportPatchInput | null {
  const result = patchSchema.safeParse(body);
  return result.success ? result.data : null;
}

const updateCreateSchema = z
  .object({
    status: updateStatusSchema,
    markdown: markdownSchema,
    publishedAt: timestampSchema.optional(),
  })
  .strict();

const updateEditSchema = z
  .object({
    status: updateStatusSchema.optional(),
    markdown: markdownSchema.optional(),
    publishedAt: timestampSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field to update" });

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new StatusReportError("VALIDATION_ERROR", `Invalid status report request${at}: ${issue?.message ?? "invalid input"}`, {
      issues: parsed.error.issues.map((entry) => ({ path: entry.path.join("."), message: entry.message })),
    });
  }
  return parsed.data;
}

function assertStatusMatchesType(type: StatusReportType, status: StatusReportUpdateStatus) {
  const allowed: readonly string[] = type === "incident" ? INCIDENT_UPDATE_STATUSES : MAINTENANCE_UPDATE_STATUSES;
  if (!allowed.includes(status)) {
    throw new StatusReportError(
      "VALIDATION_ERROR",
      `Update status must be one of ${allowed.join(", ")} for ${type} reports`,
      { status },
    );
  }
}

/**
 * Per-type impact vocabulary, mirroring the dashboard editor's own picker
 * (impactOptions in components/incidents/report-status.ts): incidents offer
 * down/degraded, maintenance windows offer maintenance/degraded, neither
 * type exposes the other's exclusive impact. Enforced here too so a non-UI
 * client (API/CLI) can't persist a contradictory pairing, e.g. an incident
 * report with impact "maintenance" or a maintenance report with impact
 * "down", which would render a nonsensical public label.
 */
const IMPACT_BY_TYPE: Record<StatusReportType, readonly StatusReportImpact[]> = {
  incident: ["down", "degraded"],
  maintenance: ["maintenance", "degraded"],
};

function assertAffectedMatchesType(
  type: StatusReportType,
  entries: ReadonlyArray<{ monitorId: string; impact: StatusReportImpact }>,
) {
  const allowed = IMPACT_BY_TYPE[type];
  for (const entry of entries) {
    if (!allowed.includes(entry.impact)) {
      throw new StatusReportError(
        "VALIDATION_ERROR",
        `Affected impact must be one of ${allowed.join(", ")} for ${type} reports`,
        { monitorId: entry.monitorId, impact: entry.impact },
      );
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
function assertNoIncidentWindow(type: StatusReportType, endsAt: Date | null | undefined) {
  if (type === "incident" && endsAt != null) {
    throw new StatusReportError("VALIDATION_ERROR", "endsAt is not allowed for incident reports", { type });
  }
}

/**
 * Total order for updates: (publishedAt, createdAt, id). The tiebreak is part
 * of the API contract: backdated updates with identical timestamps resolve
 * deterministically everywhere (service, DISTINCT ON query, public page).
 */
export function compareReportUpdates(left: StatusReportUpdateRow, right: StatusReportUpdateRow): number {
  return (
    left.publishedAt.getTime() - right.publishedAt.getTime()
    || left.createdAt.getTime() - right.createdAt.getTime()
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

export function latestReportUpdate(updates: readonly StatusReportUpdateRow[]): StatusReportUpdateRow | null {
  if (updates.length === 0) return null;
  return [...updates].sort(compareReportUpdates).at(-1) ?? null;
}

/** null unless the latest update (by the total order) resolves the report. */
export function deriveResolvedAt(updates: readonly StatusReportUpdateRow[]): Date | null {
  const latest = latestReportUpdate(updates);
  if (!latest || !RESOLVING_STATUSES.includes(latest.status)) return null;
  return latest.publishedAt;
}

function serializeAffected(affected: readonly StatusReportAffectedRow[]): AffectedServiceData[] {
  return [...affected]
    .sort((left, right) => left.monitorId.localeCompare(right.monitorId))
    .map((row) => ({
      monitorId: row.monitorId,
      monitorName: row.monitorName,
      groupName: row.groupName,
      impact: row.impact,
    }));
}

function serializeReport(
  report: StatusReportRow,
  updates: readonly StatusReportUpdateRow[],
  affected: readonly StatusReportAffectedRow[],
): StatusReportData {
  const newestFirst = [...updates].sort((left, right) => compareReportUpdates(right, left));
  return {
    id: report.id,
    type: report.type,
    title: report.title,
    startsAt: report.startsAt.toISOString(),
    endsAt: report.endsAt?.toISOString() ?? null,
    publishedAt: report.publishedAt?.toISOString() ?? null,
    resolvedAt: report.resolvedAt?.toISOString() ?? null,
    originIncidentId: report.originIncidentId,
    currentStatus: newestFirst[0]?.status ?? (report.type === "incident" ? "investigating" : "scheduled"),
    updates: newestFirst.map((update) => ({
      id: update.id,
      status: update.status,
      markdown: update.markdown,
      publishedAt: update.publishedAt.toISOString(),
      createdAt: update.createdAt.toISOString(),
    })),
    affected: serializeAffected(affected),
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  };
}

async function snapshotAffected(
  store: StatusReportsStore,
  reportId: string,
  entries: ReadonlyArray<{ monitorId: string; impact: StatusReportImpact }>,
): Promise<StatusReportAffectedRow[]> {
  if (entries.length === 0) return [];
  const monitors = await store.findMonitors(entries.map((entry) => entry.monitorId));
  const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
  return entries.map((entry) => {
    const monitor = byId.get(entry.monitorId);
    if (!monitor) {
      throw new StatusReportError("VALIDATION_ERROR", `Affected monitor "${entry.monitorId}" was not found`, {
        monitorId: entry.monitorId,
      });
    }
    return {
      reportId,
      monitorId: monitor.id,
      monitorName: monitor.name,
      groupName: monitor.groupName,
      impact: entry.impact,
    };
  });
}

async function loadReportData(store: StatusReportsStore, report: StatusReportRow): Promise<StatusReportData> {
  const { updates, affected } = await store.getReportDetails([report.id]);
  return serializeReport(report, updates, affected);
}

export async function getStatusReport(id: string, dependencies: StatusReportsDependencies = {}): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const report = await store.getReport(id);
  if (!report) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  return loadReportData(store, report);
}

export function parseStatusReportListQuery(input: {
  state: string | null;
  type: string | null;
  cursor: string | null;
}): { state: StatusReportListState; type: StatusReportListType; cursor: { createdAt: Date; id: string } | null } {
  const state = input.state ?? "all";
  const type = input.type ?? "all";
  if (!["all", "draft", "ongoing", "resolved"].includes(state)) {
    throw new StatusReportError("VALIDATION_ERROR", "State must be all, draft, ongoing, or resolved");
  }
  if (!["all", "incident", "maintenance"].includes(type)) {
    throw new StatusReportError("VALIDATION_ERROR", "Type must be all, incident, or maintenance");
  }
  let cursor: { createdAt: Date; id: string } | null = null;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    const createdAt = decoded ? new Date(decoded.sort) : null;
    if (!decoded || !createdAt || Number.isNaN(createdAt.getTime()) || !isUuid(decoded.id)) {
      throw new StatusReportError("INVALID_CURSOR", "Cursor is invalid");
    }
    cursor = { createdAt, id: decoded.id };
  }
  return { state: state as StatusReportListState, type: type as StatusReportListType, cursor };
}

export async function listStatusReports(
  input: {
    state: StatusReportListState;
    type: StatusReportListType;
    cursor: { createdAt: Date; id: string } | null;
    limit: number;
  },
  dependencies: StatusReportsDependencies = {},
): Promise<{ data: StatusReportData[]; nextCursor: string | null }> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const rows = await store.listReports(input);
  const page = rows.slice(0, input.limit);
  const { updates, affected } = page.length > 0
    ? await store.getReportDetails(page.map((row) => row.id))
    : { updates: [], affected: [] };
  const last = page.at(-1);
  return {
    data: page.map((report) => serializeReport(
      report,
      updates.filter((update) => update.reportId === report.id),
      affected.filter((row) => row.reportId === report.id),
    )),
    nextCursor: rows.length > input.limit && last
      ? encodeCursor({ sort: last.createdAt.toISOString(), id: last.id })
      : null,
  };
}

/**
 * List path: one page query + one batched details fan-out (counts,
 * DISTINCT ON latest status/publishedAt, affected). Never fetches markdown,
 * the detailed shape stays on getStatusReport.
 */
export async function listStatusReportSummaries(
  input: {
    state: StatusReportListState;
    type: StatusReportListType;
    cursor: { createdAt: Date; id: string } | null;
    limit: number;
  },
  dependencies: StatusReportsDependencies = {},
): Promise<{ data: StatusReportListItemData[]; nextCursor: string | null }> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const rows = await store.listReports(input);
  const page = rows.slice(0, input.limit);
  const { counts, latest, affected } = page.length > 0
    ? await store.getListDetails(page.map((row) => row.id))
    : { counts: [], latest: [], affected: [] };
  const countByReport = new Map(counts.map((entry) => [entry.reportId, entry.count]));
  const latestByReport = new Map(latest.map((entry) => [entry.reportId, entry]));
  const last = page.at(-1);
  return {
    data: page.map((report) => {
      const latestUpdate = latestByReport.get(report.id) ?? null;
      return {
        id: report.id,
        type: report.type,
        title: report.title,
        startsAt: report.startsAt.toISOString(),
        endsAt: report.endsAt?.toISOString() ?? null,
        publishedAt: report.publishedAt?.toISOString() ?? null,
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        originIncidentId: report.originIncidentId,
        currentStatus: latestUpdate?.status ?? (report.type === "incident" ? "investigating" : "scheduled"),
        updatesCount: countByReport.get(report.id) ?? 0,
        latestUpdate: latestUpdate
          ? { status: latestUpdate.status, publishedAt: latestUpdate.publishedAt.toISOString() }
          : null,
        affected: serializeAffected(affected.filter((row) => row.reportId === report.id)),
        createdAt: report.createdAt.toISOString(),
        updatedAt: report.updatedAt.toISOString(),
      };
    }),
    nextCursor: rows.length > input.limit && last
      ? encodeCursor({ sort: last.createdAt.toISOString(), id: last.id })
      : null,
  };
}

export async function createStatusReport(
  input: unknown,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const newId = dependencies.newId ?? (() => crypto.randomUUID());
  const parsed = parseOrThrow(createSchema, input);
  assertStatusMatchesType(parsed.type, parsed.update.status);
  assertNoIncidentWindow(parsed.type, parsed.endsAt);
  assertAffectedMatchesType(parsed.type, parsed.affected ?? []);

  // Validate against the EFFECTIVE startsAt (the explicit value, or the `now`
  // default applied below). An omitted startsAt must not let an endsAt in
  // the past slip past validation and persist an inverted window.
  const effectiveStartsAt = parsed.startsAt ?? now;
  if (parsed.endsAt && parsed.endsAt.getTime() <= effectiveStartsAt.getTime()) {
    throw new StatusReportError("VALIDATION_ERROR", "endsAt must be after startsAt", {
      startsAt: effectiveStartsAt.toISOString(),
      endsAt: parsed.endsAt.toISOString(),
    });
  }

  const reportId = dependencies.reportId ?? newId();
  const update: StatusReportUpdateRow = {
    id: newId(),
    reportId,
    status: parsed.update.status,
    markdown: parsed.update.markdown,
    publishedAt: parsed.update.publishedAt ?? now,
    createdAt: now,
    updatedAt: now,
  };
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
  };
  const affected = await snapshotAffected(store, reportId, parsed.affected ?? []);
  await store.insertReport({ report, update, affected });
  return serializeReport(report, [update], affected);
}

/**
 * Idempotency recovery for POST /status-reports: called only after a stale
 * "running" record is reclaimed (i.e. a prior attempt crashed after
 * inserting but before the idempotency record was marked complete). The
 * route pins the report id to the idempotency operationId, so recovering is
 * just "does a report with this id exist," no need to recompute or compare a
 * content hash the way monitor creation does, since the id itself is unique
 * to this exact operation.
 */
export async function recoverCreatedStatusReport(
  id: string,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData | null> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const report = await store.getReport(id);
  if (!report) return null;
  return loadReportData(store, report);
}

export async function updateStatusReport(
  id: string,
  input: unknown,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const parsed = parseOrThrow(patchSchema, input);
  const existing = await store.getReport(id);
  if (!existing) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  // A patch can't change `type` (it's not a patchable field), so the
  // existing report's type governs both checks below. Only the CALLER'S
  // own endsAt is checked (not the merged/effective value): a title- or
  // affected-only patch must not start failing because of pre-existing
  // data, only a patch that itself tries to add a window to an incident.
  assertNoIncidentWindow(existing.type, parsed.endsAt);
  if (parsed.affected !== undefined) assertAffectedMatchesType(existing.type, parsed.affected);

  // A partial patch touching only one bound must still validate against the
  // EFFECTIVE other bound (the existing report's, when the patch leaves it
  // untouched), not just the bound(s) the caller happened to send.
  const effectiveStartsAt = parsed.startsAt ?? existing.startsAt;
  const effectiveEndsAt = parsed.endsAt !== undefined ? parsed.endsAt : existing.endsAt;
  if (effectiveEndsAt && effectiveEndsAt.getTime() <= effectiveStartsAt.getTime()) {
    throw new StatusReportError("VALIDATION_ERROR", "endsAt must be after startsAt", {
      startsAt: effectiveStartsAt.toISOString(),
      endsAt: effectiveEndsAt.toISOString(),
    });
  }

  // Affected is a FULL REPLACEMENT with fresh registry snapshots.
  const affected = parsed.affected === undefined ? undefined : await snapshotAffected(store, id, parsed.affected);
  const patch: { title?: string; startsAt?: Date; endsAt?: Date | null } = {};
  if (parsed.title !== undefined) patch.title = parsed.title;
  if (parsed.startsAt !== undefined) patch.startsAt = parsed.startsAt;
  if (parsed.endsAt !== undefined) patch.endsAt = parsed.endsAt;
  const report = await store.updateReport({ id, patch, affected, now });
  if (!report) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  return loadReportData(store, report);
}

export async function deleteStatusReport(id: string, dependencies: StatusReportsDependencies = {}): Promise<{ id: string }> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const deleted = await store.deleteReport(id);
  if (!deleted) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  return { id };
}

/**
 * Idempotency recovery for DELETE /status-reports/{id}. deleteReport is a
 * guarded DELETE ... RETURNING: a concurrent delete of the SAME report would
 * itself observe zero rows and record its own REPORT_NOT_FOUND rather than
 * staying "running", so a record left running here, with the report now
 * gone, proves THIS operation is what deleted it. Returns true (recovered
 * success) when the report is gone, or false when it still exists (a
 * genuine crash before the delete committed), so work() reruns and performs
 * the real delete.
 *
 * MALFORMED ids are rejected up front rather than handed to the store: a
 * malformed id can never have identified a real report, so getReport's
 * isUuid guard returning null for it is indistinguishable from "this
 * recovery's own crashed delete already removed it". Without the check
 * below, a first attempt that crashed on a genuine 404 (bad id, never
 * touched a row) would be recovered as a false 200 instead of the true
 * REPORT_NOT_FOUND work() would otherwise record. Returning false here lets
 * work() rerun and record that genuine 404.
 *
 * WELL-FORMED ids that simply never existed are NOT distinguishable from "a
 * crashed delete already removed this one" without a tombstone. That
 * residual is accepted, same class as the documented publish residual
 * (recoverPublishedStatusReport) and the config PUT recover residual
 * (app/api/v1/status-page-config/route.ts): DELETE is an idempotent
 * target-state operation, so answering 200 on a retry against an absent
 * well-formed target reflects the achieved state either way: RFC 9110
 * §9.3.5 explicitly allows a DELETE of an already-absent resource to answer
 * either 200 or 404.
 */
export async function recoverDeletedStatusReport(
  id: string,
  dependencies: StatusReportsDependencies = {},
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const store = dependencies.store ?? databaseStatusReportsStore;
  const existing = await store.getReport(id);
  return existing === null;
}

/**
 * Shared tail of the update mutations: recompute+persist the resolution
 * under the report-row lock (with the affected rows in parallel), and build
 * the response from the rows already in hand rather than a trailing
 * getStatusReport re-fetch, keeping each mutation to at most 4 sequential
 * round-trips.
 */
async function persistResolutionAndSerialize(
  store: StatusReportsStore,
  report: StatusReportRow,
  now: Date,
): Promise<StatusReportData> {
  const [recomputed, affected] = await Promise.all([
    store.recomputeResolution({ reportId: report.id, now }),
    store.getAffected([report.id]),
  ]);
  if (!recomputed) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  return serializeReport(
    { ...report, resolvedAt: recomputed.resolvedAt, updatedAt: now },
    recomputed.updates,
    affected,
  );
}

export async function addReportUpdate(
  reportId: string,
  input: unknown,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const newId = dependencies.newId ?? (() => crypto.randomUUID());
  const parsed = parseOrThrow(updateCreateSchema, input);
  const existing = await store.getReport(reportId);
  if (!existing) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  assertStatusMatchesType(existing.type, parsed.status);

  const update: StatusReportUpdateRow = {
    id: dependencies.updateId ?? newId(),
    reportId,
    status: parsed.status,
    markdown: parsed.markdown,
    publishedAt: parsed.publishedAt ?? now,
    createdAt: now,
    updatedAt: now,
  };
  // Row-locked insert: closes the race where a concurrent DELETE commits
  // between the existence check above and the insert. A report deleted in
  // that window must be re-detected here, inside the lock, as
  // REPORT_NOT_FOUND, never let the insert crash against a
  // gone-but-still-referenced report_id as a raw foreign-key-violation 500.
  const report = await store.insertReportUpdate({ reportId, update });
  if (!report) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  return persistResolutionAndSerialize(store, report, now);
}

/**
 * Idempotency recovery for POST /status-reports/{id}/updates, mirroring
 * recoverCreatedStatusReport: the route pins the new update's id to the
 * idempotency operationId, so recovering after a reclaimed stale record is
 * "does the report still exist AND carry an update with this id" rather than
 * re-running the callback and inserting a second update.
 */
export async function recoverAddedReportUpdate(
  reportId: string,
  updateId: string,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData | null> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const report = await store.getReport(reportId);
  if (!report) return null;
  // Point lookup by the pinned update id, never a scan: getReportDetails caps
  // at PER_REPORT_UPDATE_LIMIT newest rows, so a backdated update whose
  // publishedAt sorts behind 500+ newer ones must still be found here rather
  // than missed into a spurious rerun that inserts a duplicate.
  const inserted = await store.getUpdate(reportId, updateId);
  if (!inserted) return null;
  // The crash this recovers from may have landed between the insert
  // committing and the resolution recompute running, so resolution must be
  // recomputed and persisted here too, via the same idempotent recompute the
  // success path uses, rather than trusting the possibly-stale resolvedAt
  // already on the report row.
  return persistResolutionAndSerialize(store, report, now);
}

export async function editReportUpdate(
  reportId: string,
  updateId: string,
  input: unknown,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const parsed = parseOrThrow(updateEditSchema, input);
  const report = await store.getReport(reportId);
  if (!report) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  if (parsed.status !== undefined) assertStatusMatchesType(report.type, parsed.status);

  const edited = await store.editUpdate({ reportId, updateId, patch: parsed, now });
  if (!edited) throw new StatusReportError("UPDATE_NOT_FOUND", "Report update was not found");
  return persistResolutionAndSerialize(store, report, now);
}

/**
 * Idempotency recovery for PATCH /status-reports/{id}/updates/{updateId}.
 * Recovery is "the report and update still exist, and the update's CURRENT
 * fields already match everything this patch asked for":
 * status/markdown/publishedAt compared only where the caller sent them,
 * mirroring statusReportPatchAlreadyApplied for the report-level PATCH. A
 * genuine difference (crash landed before the edit committed) or an unknown
 * report/update returns null so work() reruns normally.
 */
export async function recoverEditedReportUpdate(
  reportId: string,
  updateId: string,
  patch: unknown,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData | null> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const report = await store.getReport(reportId);
  if (!report) return null;
  // Point lookup by id (uncapped) rather than the capped getReportDetails
  // scan (mirrors recoverAddedReportUpdate): PER_REPORT_UPDATE_LIMIT could
  // otherwise miss a backdated update on a report with 500+ newer ones.
  const current = await store.getUpdate(reportId, updateId);
  if (!current || !reportUpdatePatchAlreadyApplied(current, patch)) return null;
  return persistResolutionAndSerialize(store, report, now);
}

/**
 * Unlike statusReportPatchAlreadyApplied, this compares the RAW body fields
 * (not a schema-parsed result), audited and confirmed safe: of the three
 * comparable fields, `status` is an enum with no coercion, `markdown` is
 * validated but never trimmed/transformed by updateEditSchema (only its
 * *trimmed length* is checked, the persisted value is the raw string), and
 * `publishedAt` is parsed inline via Date.parse right below rather than
 * relying on the schema's Date transform. No field this function compares is
 * normalized by updateEditSchema in a way the raw-body comparison would miss,
 * so the trim-mismatch risk statusReportPatchAlreadyApplied
 * (lib/api/status-report-http.ts) guards against does not apply here.
 */
function reportUpdatePatchAlreadyApplied(
  current: Pick<StatusReportUpdateRow, "status" | "markdown" | "publishedAt">,
  body: unknown,
): boolean {
  // Gate on the SAME schema the real edit would have to pass: an INVALID
  // patch (`{}`, or a body with only unsupported keys) has no recognized
  // field to mismatch and must return false here, not fall through to
  // `true` and turn a stale retry's genuine VALIDATION_ERROR into a false
  // recovered 200.
  if (!updateEditSchema.safeParse(body).success) return false;
  if (body === null || typeof body !== "object") return false;
  const patch = body as Record<string, unknown>;
  if ("status" in patch && patch.status !== current.status) return false;
  if ("markdown" in patch && patch.markdown !== current.markdown) return false;
  if ("publishedAt" in patch) {
    const value = patch.publishedAt;
    if (typeof value !== "string") return false;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed) || parsed !== current.publishedAt.getTime()) return false;
  }
  return true;
}

export async function deleteReportUpdate(
  reportId: string,
  updateId: string,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const report = await store.getReport(reportId);
  if (!report) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  // The store enforces the LAST_UPDATE invariant transactionally: the report
  // row is locked before the surviving count is read, so two concurrent
  // deletes cannot both observe "another update still exists" and race a
  // report down to zero updates.
  const outcome = await store.deleteUpdate({ reportId, updateId });
  if (outcome === "missing") throw new StatusReportError("UPDATE_NOT_FOUND", "Report update was not found");
  if (outcome === "last_update") {
    throw new StatusReportError("LAST_UPDATE", "A report must keep at least one update; delete the report instead");
  }
  return persistResolutionAndSerialize(store, report, now);
}

/**
 * Idempotency recovery for DELETE /status-reports/{id}/updates/{updateId}.
 * deleteUpdate is a row-locked, guarded delete: a concurrent delete of the
 * SAME update would itself observe it already gone and record its own
 * UPDATE_NOT_FOUND rather than staying "running", so a record left running
 * here, with the update now gone (and the report still present), proves THIS
 * operation is what deleted it. Recomputes+persists resolution the same way
 * the success path does (mirrors recoverEditedReportUpdate/
 * recoverAddedReportUpdate), since the crash this recovers from may have
 * landed between the delete committing and the recompute running. Returns
 * null (so work() reruns and records the genuine outcome) when the update
 * still exists (a genuine crash before the delete committed, which reruns
 * into the real delete/LAST_UPDATE guard) or the report itself is gone (a
 * separate report-level delete since made the question moot, work() reruns
 * and records the truthful current REPORT_NOT_FOUND).
 *
 * A MALFORMED updateId is rejected up front rather than handed to
 * store.getUpdate: a malformed id can never have identified a real update,
 * so the store's isUuid guard returning null for it is indistinguishable
 * from "this recovery's own crashed delete already removed it". Without the
 * check below, a first attempt that crashed on a genuine 404 (bad id, never
 * touched a row) would be recovered as a false 200 instead of the true
 * UPDATE_NOT_FOUND work() would otherwise record. Returning null here
 * (mirrors recoverDeletedStatusReport) lets work() rerun and record that
 * genuine 404.
 *
 * A WELL-FORMED updateId that simply never existed is NOT distinguishable
 * from "a crashed delete already removed it" without a tombstone. Accepted,
 * same residual as recoverDeletedStatusReport / recoverPublishedStatusReport:
 * DELETE is idempotent target-state, so 200 on a retry against an absent
 * well-formed target reflects the achieved state (RFC 9110 §9.3.5).
 */
export async function recoverDeletedReportUpdate(
  reportId: string,
  updateId: string,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData | null> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const report = await store.getReport(reportId);
  if (!report) return null;
  if (!isUuid(updateId)) return null;
  const current = await store.getUpdate(reportId, updateId);
  if (current) return null;
  return persistResolutionAndSerialize(store, report, now);
}

export async function publishStatusReport(
  id: string,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const outcome = await store.publishReport({ id, now });
  if (outcome === "missing") throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  if (outcome === "already_published") {
    throw new StatusReportError("ALREADY_PUBLISHED", "The status report is already published");
  }
  return getStatusReport(id, dependencies);
}

/**
 * Idempotency recovery for POST /status-reports/{id}/publish. The guarded
 * UPDATE ... WHERE published_at IS NULL is what makes recovering safe: a
 * concurrent publish of the SAME report would itself observe the row
 * already published and record its own 409 rather than staying "running",
 * so a record left running here, with the report now published, proves THIS
 * operation is what published it. Returns the current report when it's
 * published, or null (an unpublished or now-missing report) so work()
 * reruns and records the genuine outcome (a real ALREADY_PUBLISHED conflict,
 * or REPORT_NOT_FOUND).
 */
export async function recoverPublishedStatusReport(
  id: string,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData | null> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const report = await store.getReport(id);
  if (!report || !report.publishedAt) return null;
  return loadReportData(store, report);
}

/** Matches the public label in lib/reporting/queries/status.ts (failureLabel). */
export function publicIncidentCause(openingStatusCode: number | null): string {
  return openingStatusCode !== null ? `HTTP ${openingStatusCode}` : "Availability check failed";
}

/**
 * Prefills a DRAFT report from an auto-incident. Idempotent via the partial
 * unique index on originIncidentId: promoting the same incident twice returns
 * the existing report, whichever caller won the insert race.
 */
export async function promoteIncident(
  incidentId: string,
  dependencies: StatusReportsDependencies = {},
): Promise<{ report: StatusReportData; created: boolean }> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const newId = dependencies.newId ?? (() => crypto.randomUUID());
  const incident = await store.findIncident(incidentId);
  if (!incident) throw new StatusReportError("INCIDENT_NOT_FOUND", "Incident was not found");

  const reportId = dependencies.reportId ?? newId();
  const cause = publicIncidentCause(incident.openingStatusCode);
  const update: StatusReportUpdateRow = {
    id: newId(),
    reportId,
    status: "investigating",
    markdown: `We are investigating an outage affecting ${incident.monitorName}. Initial signal: ${cause}.`,
    publishedAt: incident.openedAt,
    createdAt: now,
    updatedAt: now,
  };
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
  };
  const affected: StatusReportAffectedRow[] = [{
    reportId,
    monitorId: incident.monitorId,
    monitorName: incident.monitorName,
    groupName: incident.groupName,
    impact: "down",
  }];
  const outcome = await store.insertPromotedReport({ report, update, affected });
  if (outcome.created) {
    return { report: serializeReport(report, [update], affected), created: true };
  }
  return { report: await getStatusReport(outcome.id, dependencies), created: false };
}

/**
 * Idempotency recovery for POST /incidents/{incidentId}/promote.
 * promoteIncident is safe to rerun outright: insertPromotedReport's
 * conflict path on the partial unique index on originIncidentId just returns
 * the existing report, but recovery lets a retry short-circuit at this
 * point lookup instead of reaching the database, re-validating the incident,
 * and re-serializing fresh values on every replay. Returns the existing
 * report for this incident, or null when no report exists yet so work()
 * reruns to create it.
 *
 * The route distinguishes created (201) from already-existing (200) by
 * comparing the recovered report's id to the idempotency operationId:
 * promoteIncident pins its new report's id to dependencies.reportId (the
 * operationId), and claimStale reuses the SAME record id across a stale
 * reclaim, so a match here means THIS crashed attempt inserted the row, a
 * mismatch means some other operation (a concurrent promote, or one that
 * already completed) created it.
 */
export async function recoverPromotedReport(
  incidentId: string,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData | null> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const existing = await store.getReportByOriginIncident(incidentId);
  if (!existing) return null;
  return loadReportData(store, existing);
}

export type PublicReportPhase = "ongoing" | "upcoming" | "window_ended" | "resolved";

export type PublicStatusReport = {
  id: string;
  type: StatusReportType;
  title: string;
  startsAt: string;
  endsAt: string | null;
  publishedAt: string;
  resolvedAt: string | null;
  originIncidentId: string | null;
  currentStatus: StatusReportUpdateStatus;
  phase: PublicReportPhase;
  latestUpdate: StatusReportUpdateData | null;
  affected: AffectedServiceData[];
};

export type PublicReports = {
  ongoing: PublicStatusReport[];
  upcoming: PublicStatusReport[];
  windowEnded: PublicStatusReport[];
  resolved: PublicStatusReport[];
};

export const PUBLIC_RESOLVED_LIMIT = 10;

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
export type PublicReportsFilter = { monitorIds: readonly string[]; groupSlug: string };

/**
 * Store-level prefilter with the slug already resolved to the exact
 * snapshotted group names it matches, so the store can compare raw strings.
 */
export type PublicReportRowsFilter = { monitorIds: readonly string[]; groupNames: readonly string[] };

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
  now: Date,
): PublicReportPhase {
  if (report.resolvedAt) return "resolved";
  if (report.startsAt.getTime() > now.getTime()) return "upcoming";
  if (report.type === "maintenance" && report.endsAt && report.endsAt.getTime() <= now.getTime()) {
    return "window_ended";
  }
  return "ongoing";
}

/**
 * Batched public read, exactly 3 queries: (1) published reports through
 * the partial indexes, (2) latest update per report via DISTINCT ON with the
 * contract total order, (3) affected rows. Drafts never appear.
 *
 * `filter` scopes query 1 to a single group's reports (via EXISTS against
 * status_report_affected) for /status/[group] pages, adding one small
 * distinct-names query up front to resolve the slug. The root page passes no
 * filter so its resolved LIMIT stays global. Queries 2 and 3 automatically
 * inherit the scoping since they only fan out over the ids query 1 returned.
 */
export async function getPublicReports(
  dependencies: StatusReportsDependencies = {},
  filter?: PublicReportsFilter,
): Promise<PublicReports> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  // Slug resolution happens in JS, never in SQL: statusGroupSlug's NFKD
  // normalization and punctuation folding have no portable SQL equivalent,
  // so the exact snapshot names whose slug matches are enumerated here and
  // the store compares raw strings against that list. By construction the
  // SQL prefilter then keeps exactly the affected rows the JS slug filter
  // (filterReportsForGroupSlug) would keep, so the row caps inside
  // getPublicReportRows apply after group scoping and can never starve a
  // group whose only reports are older than unrelated global history.
  const rowsFilter = filter
    ? {
        monitorIds: filter.monitorIds,
        groupNames: [...new Set((await store.getAffectedGroupNames()).map((name) => name ?? "Other"))]
          .filter((name) => statusGroupSlug(name) === filter.groupSlug),
      }
    : undefined;
  const rows = await store.getPublicReportRows({ resolvedLimit: PUBLIC_RESOLVED_LIMIT, now, filter: rowsFilter });
  const published = rows.filter((row) => row.publishedAt !== null);
  const ids = published.map((row) => row.id);
  const [latestUpdates, affected] = ids.length === 0
    ? [[], []]
    : await Promise.all([store.getLatestUpdates(ids), store.getAffected(ids)]);
  const latestByReport = new Map(latestUpdates.map((update) => [update.reportId, update]));

  const result: PublicReports = { ongoing: [], upcoming: [], windowEnded: [], resolved: [] };
  for (const report of published) {
    const latest = latestByReport.get(report.id) ?? null;
    const phase = classifyPublicReport(report, now);
    const entry: PublicStatusReport = {
      id: report.id,
      type: report.type,
      title: report.title,
      startsAt: report.startsAt.toISOString(),
      endsAt: report.endsAt?.toISOString() ?? null,
      publishedAt: report.publishedAt!.toISOString(),
      resolvedAt: report.resolvedAt?.toISOString() ?? null,
      originIncidentId: report.originIncidentId,
      currentStatus: latest?.status ?? (report.type === "incident" ? "investigating" : "scheduled"),
      phase,
      latestUpdate: latest
        ? {
            id: latest.id,
            status: latest.status,
            markdown: latest.markdown,
            publishedAt: latest.publishedAt.toISOString(),
            createdAt: latest.createdAt.toISOString(),
          }
        : null,
      affected: affected
        .filter((row) => row.reportId === report.id)
        .sort((left, right) => left.monitorId.localeCompare(right.monitorId))
        .map((row) => ({
          monitorId: row.monitorId,
          monitorName: row.monitorName,
          groupName: row.groupName,
          impact: row.impact,
        })),
    };
    if (phase === "ongoing") result.ongoing.push(entry);
    else if (phase === "upcoming") result.upcoming.push(entry);
    else if (phase === "window_ended") result.windowEnded.push(entry);
    else result.resolved.push(entry);
  }
  result.ongoing.sort((left, right) => right.startsAt.localeCompare(left.startsAt));
  result.upcoming.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  result.windowEnded.sort((left, right) => right.startsAt.localeCompare(left.startsAt));
  result.resolved.sort((left, right) => (right.resolvedAt ?? "").localeCompare(left.resolvedAt ?? ""));
  return result;
}

/**
 * Route params reach the store verbatim. A non-UUID value would make Postgres
 * raise 22P02 on the uuid comparison (a 500) instead of a clean 404. Mirrors
 * lib/api/images.ts.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Detail reads keep at most this many (newest) updates per report. */
const PER_REPORT_UPDATE_LIMIT = 500;

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
};

const updateSelection = {
  id: statusReportUpdates.id,
  reportId: statusReportUpdates.reportId,
  status: statusReportUpdates.status,
  markdown: statusReportUpdates.markdown,
  publishedAt: statusReportUpdates.publishedAt,
  createdAt: statusReportUpdates.createdAt,
  updatedAt: statusReportUpdates.updatedAt,
};

const affectedSelection = {
  reportId: statusReportAffected.reportId,
  monitorId: statusReportAffected.monitorId,
  monitorName: statusReportAffected.monitorName,
  groupName: statusReportAffected.groupName,
  impact: statusReportAffected.impact,
};

export const databaseStatusReportsStore: StatusReportsStore = {
  async findMonitors(ids) {
    if (ids.length === 0) return [];
    return db
      .select({ id: monitorRegistry.id, name: monitorRegistry.name, groupName: monitorRegistry.groupName })
      .from(monitorRegistry)
      .where(inArray(monitorRegistry.id, [...ids]));
  },

  async insertReport({ report, update, affected }) {
    await db.transaction(async (tx) => {
      await tx.insert(statusReports).values(report);
      await tx.insert(statusReportUpdates).values(update);
      if (affected.length > 0) await tx.insert(statusReportAffected).values(affected);
    });
  },

  async insertPromotedReport({ report, update, affected }) {
    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(statusReports)
        .values(report)
        .onConflictDoNothing({
          target: statusReports.originIncidentId,
          where: sql`${statusReports.originIncidentId} is not null`,
        })
        .returning({ id: statusReports.id });
      if (!inserted[0]) {
        const [existing] = await tx
          .select({ id: statusReports.id })
          .from(statusReports)
          .where(eq(statusReports.originIncidentId, report.originIncidentId!))
          .limit(1);
        if (!existing) throw new Error("Promotion conflict without an existing report");
        return { id: existing.id, created: false };
      }
      await tx.insert(statusReportUpdates).values(update);
      if (affected.length > 0) await tx.insert(statusReportAffected).values(affected);
      return { id: report.id, created: true };
    });
  },

  async getReport(id) {
    if (!isUuid(id)) return null;
    const [row] = await db.select(reportSelection).from(statusReports).where(eq(statusReports.id, id)).limit(1);
    return row ?? null;
  },

  async listReports({ state, type, cursor, limit }) {
    const conditions = [];
    if (state === "draft") conditions.push(isNull(statusReports.publishedAt));
    if (state === "ongoing") conditions.push(isNotNull(statusReports.publishedAt), isNull(statusReports.resolvedAt));
    if (state === "resolved") conditions.push(isNotNull(statusReports.publishedAt), isNotNull(statusReports.resolvedAt));
    if (type !== "all") conditions.push(eq(statusReports.type, type));
    if (cursor) {
      conditions.push(or(
        lt(statusReports.createdAt, cursor.createdAt),
        and(eq(statusReports.createdAt, cursor.createdAt), lt(statusReports.id, cursor.id)),
      )!);
    }
    return db
      .select(reportSelection)
      .from(statusReports)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(statusReports.createdAt), desc(statusReports.id))
      .limit(limit + 1);
  },

  async getReportDetails(ids) {
    if (ids.length === 0) return { updates: [], affected: [] };
    // Per-report bound: a window rank partitioned by report keeps the newest
    // PER_REPORT_UPDATE_LIMIT updates for EVERY requested report, so one
    // chatty report can never starve the others out of a shared global cap.
    // No outer ORDER BY, serializeReport re-sorts per report in JS anyway.
    const ranked = db.$with("ranked_updates").as(
      db
        .select({
          ...updateSelection,
          updateRank: sql<number>`row_number() over (partition by ${statusReportUpdates.reportId} order by ${statusReportUpdates.publishedAt} desc, ${statusReportUpdates.createdAt} desc, ${statusReportUpdates.id} desc)`.as("update_rank"),
        })
        .from(statusReportUpdates)
        .where(inArray(statusReportUpdates.reportId, [...ids])),
    );
    const [updates, affected] = await Promise.all([
      db
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
        .where(lte(ranked.updateRank, PER_REPORT_UPDATE_LIMIT)),
      // Bound derived from the requested reports, not an arbitrary constant:
      // each report can hold at most MAX_AFFECTED_PER_REPORT rows (enforced at
      // write time), so this cap can never truncate a page of reports that
      // are each individually within bounds.
      db.select(affectedSelection).from(statusReportAffected)
        .where(inArray(statusReportAffected.reportId, [...ids]))
        .limit(ids.length * MAX_AFFECTED_PER_REPORT),
    ]);
    return { updates, affected };
  },

  async getListDetails(ids) {
    if (ids.length === 0) return { counts: [], latest: [], affected: [] };
    const [counts, latest, affected] = await Promise.all([
      db
        .select({ reportId: statusReportUpdates.reportId, count: count() })
        .from(statusReportUpdates)
        .where(inArray(statusReportUpdates.reportId, [...ids]))
        .groupBy(statusReportUpdates.reportId),
      db
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
          desc(statusReportUpdates.id),
        ),
      db.select(affectedSelection).from(statusReportAffected)
        .where(inArray(statusReportAffected.reportId, [...ids]))
        .limit(ids.length * MAX_AFFECTED_PER_REPORT),
    ]);
    return { counts, latest, affected };
  },

  async updateReport({ id, patch, affected, now }) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(statusReports)
        .set({ ...patch, updatedAt: now })
        .where(eq(statusReports.id, id))
        .returning(reportSelection);
      if (!row) return null;
      if (affected !== undefined) {
        await tx.delete(statusReportAffected).where(eq(statusReportAffected.reportId, id));
        if (affected.length > 0) await tx.insert(statusReportAffected).values(affected);
      }
      return row;
    });
  },

  async deleteReport(id) {
    if (!isUuid(id)) return false;
    const rows = await db.delete(statusReports).where(eq(statusReports.id, id)).returning({ id: statusReports.id });
    return rows.length > 0;
  },

  async insertUpdate(row) {
    await db.insert(statusReportUpdates).values(row);
  },

  async insertReportUpdate({ reportId, update }) {
    if (!isUuid(reportId)) return null;
    // `SELECT ... FOR UPDATE` on the report serializes against a concurrent
    // DELETE on the SAME row (mirrors deleteUpdate/recomputeResolution): a
    // racing delete either commits first (the lock then finds zero rows,
    // so this returns null before ever attempting the insert), or blocks
    // behind this transaction, closing the window where an unguarded insert
    // could hit the report_id foreign key after the row was already gone.
    return db.transaction(async (tx) => {
      const [locked] = await tx
        .select(reportSelection)
        .from(statusReports)
        .where(eq(statusReports.id, reportId))
        .for("update");
      if (!locked) return null;
      await tx.insert(statusReportUpdates).values(update);
      return locked;
    });
  },

  async editUpdate({ reportId, updateId, patch, now }) {
    if (!isUuid(reportId) || !isUuid(updateId)) return null;
    const [row] = await db
      .update(statusReportUpdates)
      .set({ ...patch, updatedAt: now })
      .where(and(eq(statusReportUpdates.id, updateId), eq(statusReportUpdates.reportId, reportId)))
      .returning(updateSelection);
    return row ?? null;
  },

  async deleteUpdate({ reportId, updateId }) {
    if (!isUuid(reportId) || !isUuid(updateId)) return "missing";
    // Row-locked transaction: `SELECT ... FOR UPDATE` on the report serializes
    // concurrent deletes for the SAME report (Postgres row locks are per-row,
    // so unrelated reports never contend). The unlocked count subquery this
    // replaced let two concurrent deletes of DIFFERENT updates on a
    // two-update report both observe count=2 under READ COMMITTED and both
    // succeed, leaving zero updates. The lock forces the second transaction
    // to wait and re-observe the post-delete count.
    return db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: statusReports.id })
        .from(statusReports)
        .where(eq(statusReports.id, reportId))
        .for("update");
      if (!locked) return "missing";
      const [existing] = await tx
        .select({ id: statusReportUpdates.id })
        .from(statusReportUpdates)
        .where(and(eq(statusReportUpdates.id, updateId), eq(statusReportUpdates.reportId, reportId)))
        .limit(1);
      if (!existing) return "missing";
      const [{ total }] = await tx
        .select({ total: count() })
        .from(statusReportUpdates)
        .where(eq(statusReportUpdates.reportId, reportId));
      if (total <= 1) return "last_update";
      await tx
        .delete(statusReportUpdates)
        .where(and(eq(statusReportUpdates.id, updateId), eq(statusReportUpdates.reportId, reportId)));
      return "deleted";
    });
  },

  async getUpdate(reportId, updateId) {
    if (!isUuid(reportId) || !isUuid(updateId)) return null;
    const [row] = await db.select(updateSelection).from(statusReportUpdates)
      .where(and(eq(statusReportUpdates.id, updateId), eq(statusReportUpdates.reportId, reportId)))
      .limit(1);
    return row ?? null;
  },

  async recomputeResolution({ reportId, now }) {
    if (!isUuid(reportId)) return null;
    // Row-locked transaction: `SELECT ... FOR UPDATE` on the report serializes
    // concurrent recomputes for the SAME report, mirroring deleteUpdate's
    // guard. Without the lock, two mutations racing on the same report could
    // each list-then-derive from a snapshot taken before the OTHER's write
    // committed, and whichever's UPDATE lands last would persist a stale
    // resolvedAt over the correct one: a lost-update race. The lock forces
    // the second transaction to wait and re-read the post-write state.
    return db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: statusReports.id })
        .from(statusReports)
        .where(eq(statusReports.id, reportId))
        .for("update");
      if (!locked) return null;
      // Ordered by the contract total order with the cap taking the NEWEST
      // rows, so a capped read can never drop the update that decides
      // resolvedAt.
      const updates = await tx.select(updateSelection).from(statusReportUpdates)
        .where(eq(statusReportUpdates.reportId, reportId))
        .orderBy(desc(statusReportUpdates.publishedAt), desc(statusReportUpdates.createdAt), desc(statusReportUpdates.id))
        .limit(1_000);
      const resolvedAt = deriveResolvedAt(updates);
      await tx.update(statusReports)
        .set({ resolvedAt, updatedAt: now })
        .where(eq(statusReports.id, reportId));
      return { updates, resolvedAt };
    });
  },

  async publishReport({ id, now }) {
    if (!isUuid(id)) return "missing";
    const rows = await db
      .update(statusReports)
      .set({ publishedAt: now, updatedAt: now })
      .where(and(eq(statusReports.id, id), isNull(statusReports.publishedAt)))
      .returning({ id: statusReports.id });
    if (rows.length > 0) return "published";
    const [existing] = await db.select({ id: statusReports.id }).from(statusReports).where(eq(statusReports.id, id)).limit(1);
    return existing ? "already_published" : "missing";
  },

  async findIncident(incidentId) {
    if (!isUuid(incidentId)) return null;
    const [row] = await db
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
      .where(eq(incidents.id, incidentId))
      .limit(1);
    return row ?? null;
  },

  async getAffectedGroupNames() {
    // Distinct snapshot names are bounded by the number of group names ever
    // used across published reports, far below this cap in any real
    // deployment (the registry itself caps at 100 live monitors). The LIMIT
    // only guards against a pathological table scan.
    const rows = await db
      .selectDistinct({ groupName: statusReportAffected.groupName })
      .from(statusReportAffected)
      .limit(10_000);
    return rows.map((row) => row.groupName);
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
      : undefined;
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
    const unresolved = db
      .select(reportSelection)
      .from(statusReports)
      .where(and(
        isNotNull(statusReports.publishedAt),
        isNull(statusReports.resolvedAt),
        ...(groupScope ? [groupScope] : []),
      ))
      .orderBy(
        sql`(${statusReports.endsAt} is not null and ${statusReports.endsAt} <= ${now.toISOString()})`,
        sql`(${statusReports.startsAt} > ${now.toISOString()})`,
        sql`(case when ${statusReports.startsAt} > ${now.toISOString()} then ${statusReports.startsAt} end) asc nulls last`,
        desc(statusReports.startsAt),
      )
      .limit(100);
    const resolved = db
      .select(reportSelection)
      .from(statusReports)
      .where(and(
        isNotNull(statusReports.publishedAt),
        isNotNull(statusReports.resolvedAt),
        ...(groupScope ? [groupScope] : []),
      ))
      .orderBy(desc(statusReports.resolvedAt))
      .limit(resolvedLimit);
    return unionAll(unresolved, resolved);
  },

  async getLatestUpdates(reportIds) {
    if (reportIds.length === 0) return [];
    return db
      .selectDistinctOn([statusReportUpdates.reportId], updateSelection)
      .from(statusReportUpdates)
      .where(inArray(statusReportUpdates.reportId, [...reportIds]))
      .orderBy(
        statusReportUpdates.reportId,
        desc(statusReportUpdates.publishedAt),
        desc(statusReportUpdates.createdAt),
        desc(statusReportUpdates.id),
      );
  },

  async getAffected(reportIds) {
    if (reportIds.length === 0) return [];
    // Bound derived from the requested reports (see getReportDetails): group
    // filtering and chips must never lose rows to an arbitrary global cap.
    return db
      .select(affectedSelection)
      .from(statusReportAffected)
      .where(inArray(statusReportAffected.reportId, [...reportIds]))
      .limit(reportIds.length * MAX_AFFECTED_PER_REPORT);
  },

  async getReportByOriginIncident(incidentId) {
    if (!isUuid(incidentId)) return null;
    const [row] = await db.select(reportSelection).from(statusReports)
      .where(eq(statusReports.originIncidentId, incidentId)).limit(1);
    return row ?? null;
  },
};
