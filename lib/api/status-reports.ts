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

import { decodeCursor, encodeCursor } from "./pagination";

/**
 * Status reports service (§3.1/§3.2). Store-injected like lib/api/account.ts:
 * routes call the exported functions with the default database store; tests
 * inject an in-memory store and exercise the normative rules directly.
 *
 * Normative rules implemented here (they are part of the API contract):
 * - Current status = the latest update ordered by (publishedAt, createdAt, id).
 * - resolvedAt is recomputed from the FULL update set on every update
 *   create/edit/delete: null unless the latest update is resolved/completed.
 * - createStatusReport requires the initial update; deleteReportUpdate refuses
 *   the last one (LAST_UPDATE); publish is one-way (second call fails with
 *   ALREADY_PUBLISHED); promotion always creates a draft and is idempotent via
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
 * List-shaped row (§3.1 list path): everything a report list needs without the
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
  editUpdate(input: {
    reportId: string;
    updateId: string;
    patch: { status?: StatusReportUpdateStatus; markdown?: string; publishedAt?: Date };
    now: Date;
  }): Promise<StatusReportUpdateRow | null>;
  /**
   * Atomic guarded delete: the row is removed only while at least one other
   * update for the report exists. "last_update" = the row exists but is the
   * report's final update; "missing" = no such row.
   */
  deleteUpdate(input: { reportId: string; updateId: string }): Promise<"deleted" | "last_update" | "missing">;
  listUpdates(reportId: string): Promise<StatusReportUpdateRow[]>;
  /** Persists the recomputed resolution and bumps the report's updatedAt. */
  setResolution(input: { reportId: string; resolvedAt: Date | null; now: Date }): Promise<void>;
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
  getPublicReportRows(input: { resolvedLimit: number }): Promise<StatusReportRow[]>;
  /** Query 2: latest update per report via DISTINCT ON, total-order aligned. */
  getLatestUpdates(reportIds: readonly string[]): Promise<StatusReportUpdateRow[]>;
  /** Query 3: affected rows for the page of reports. */
  getAffected(reportIds: readonly string[]): Promise<StatusReportAffectedRow[]>;
}

export type StatusReportsDependencies = {
  store?: StatusReportsStore;
  now?: () => Date;
  newId?: () => string;
};

const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

const timestampSchema = z
  .string()
  .refine((value) => RFC3339_PATTERN.test(value) && !Number.isNaN(Date.parse(value)), {
    message: "Must be an RFC 3339 timestamp",
  })
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

const affectedListSchema = z
  .array(affectedEntrySchema)
  .max(100)
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
 * Total order for updates: (publishedAt, createdAt, id). The tiebreak is part
 * of the API contract — backdated updates with identical timestamps resolve
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
    if (!decoded || !createdAt || Number.isNaN(createdAt.getTime())) {
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
 * §3.1 list path: one page query + one batched details fan-out (counts,
 * DISTINCT ON latest status/publishedAt, affected). Never fetches markdown —
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

  const reportId = newId();
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
    startsAt: parsed.startsAt ?? now,
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
 * Shared tail of the update mutations: re-read the surviving updates (with the
 * affected rows in parallel), persist the recomputed resolution, and build the
 * response from the rows already in hand — no trailing getStatusReport
 * re-fetch (finding: ≤4 sequential round-trips per mutation).
 */
async function persistResolutionAndSerialize(
  store: StatusReportsStore,
  report: StatusReportRow,
  now: Date,
): Promise<StatusReportData> {
  const [updates, affected] = await Promise.all([
    store.listUpdates(report.id),
    store.getAffected([report.id]),
  ]);
  const resolvedAt = deriveResolvedAt(updates);
  await store.setResolution({ reportId: report.id, resolvedAt, now });
  return serializeReport({ ...report, resolvedAt, updatedAt: now }, updates, affected);
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
  const report = await store.getReport(reportId);
  if (!report) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  assertStatusMatchesType(report.type, parsed.status);

  await store.insertUpdate({
    id: newId(),
    reportId,
    status: parsed.status,
    markdown: parsed.markdown,
    publishedAt: parsed.publishedAt ?? now,
    createdAt: now,
    updatedAt: now,
  });
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

export async function deleteReportUpdate(
  reportId: string,
  updateId: string,
  dependencies: StatusReportsDependencies = {},
): Promise<StatusReportData> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const report = await store.getReport(reportId);
  if (!report) throw new StatusReportError("REPORT_NOT_FOUND", "Status report was not found");
  // The store enforces the LAST_UPDATE invariant atomically: the guarded
  // delete removes nothing when the target is the report's only update, so
  // two concurrent deletes cannot race a report down to zero updates.
  const outcome = await store.deleteUpdate({ reportId, updateId });
  if (outcome === "missing") throw new StatusReportError("UPDATE_NOT_FOUND", "Report update was not found");
  if (outcome === "last_update") {
    throw new StatusReportError("LAST_UPDATE", "A report must keep at least one update; delete the report instead");
  }
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

  const reportId = newId();
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
 * §3.1 lifecycle rules: upcoming = published ∧ startsAt > now; ongoing =
 * published ∧ startsAt ≤ now ∧ not completed; a maintenance window past endsAt
 * with no completing update is demoted to "window_ended"; a `scheduled`
 * current status never places a report in the ongoing section.
 */
export function classifyPublicReport(
  report: Pick<StatusReportRow, "type" | "startsAt" | "endsAt" | "resolvedAt">,
  currentStatus: StatusReportUpdateStatus | null,
  now: Date,
): PublicReportPhase {
  if (report.resolvedAt) return "resolved";
  if (report.type === "maintenance") {
    if (report.endsAt && report.endsAt.getTime() <= now.getTime()) return "window_ended";
    if (report.startsAt.getTime() > now.getTime() || currentStatus === "scheduled") return "upcoming";
    return "ongoing";
  }
  return "ongoing";
}

/**
 * §3.2 batched public read — exactly 3 queries: (1) published reports through
 * the partial indexes, (2) latest update per report via DISTINCT ON with the
 * contract total order, (3) affected rows. Drafts never appear.
 */
export async function getPublicReports(dependencies: StatusReportsDependencies = {}): Promise<PublicReports> {
  const store = dependencies.store ?? databaseStatusReportsStore;
  const now = dependencies.now?.() ?? new Date();
  const rows = await store.getPublicReportRows({ resolvedLimit: PUBLIC_RESOLVED_LIMIT });
  const published = rows.filter((row) => row.publishedAt !== null);
  const ids = published.map((row) => row.id);
  const [latestUpdates, affected] = ids.length === 0
    ? [[], []]
    : await Promise.all([store.getLatestUpdates(ids), store.getAffected(ids)]);
  const latestByReport = new Map(latestUpdates.map((update) => [update.reportId, update]));

  const result: PublicReports = { ongoing: [], upcoming: [], windowEnded: [], resolved: [] };
  for (const report of published) {
    const latest = latestByReport.get(report.id) ?? null;
    const phase = classifyPublicReport(report, latest?.status ?? null, now);
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
 * Route params reach the store verbatim; a non-UUID value would make Postgres
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
    // No outer ORDER BY — serializeReport re-sorts per report in JS anyway.
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
      db.select(affectedSelection).from(statusReportAffected)
        .where(inArray(statusReportAffected.reportId, [...ids]))
        .limit(2_000),
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
        .limit(2_000),
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
    // Guarded single statement: the delete only fires while the report still
    // has another update, so the LAST_UPDATE invariant holds under races —
    // zero rows deleted while the row exists maps to "last_update".
    const rows = await db
      .delete(statusReportUpdates)
      .where(and(
        eq(statusReportUpdates.id, updateId),
        eq(statusReportUpdates.reportId, reportId),
        sql`(select count(*) from ${statusReportUpdates} where ${statusReportUpdates.reportId} = ${reportId}) > 1`,
      ))
      .returning({ id: statusReportUpdates.id });
    if (rows.length > 0) return "deleted";
    const [existing] = await db
      .select({ id: statusReportUpdates.id })
      .from(statusReportUpdates)
      .where(and(eq(statusReportUpdates.id, updateId), eq(statusReportUpdates.reportId, reportId)))
      .limit(1);
    return existing ? "last_update" : "missing";
  },

  async listUpdates(reportId) {
    // Ordered by the contract total order with the cap taking the NEWEST rows,
    // so a capped read can never drop the update that decides resolvedAt.
    return db.select(updateSelection).from(statusReportUpdates)
      .where(eq(statusReportUpdates.reportId, reportId))
      .orderBy(desc(statusReportUpdates.publishedAt), desc(statusReportUpdates.createdAt), desc(statusReportUpdates.id))
      .limit(1_000);
  },

  async setResolution({ reportId, resolvedAt, now }) {
    await db.update(statusReports)
      .set({ resolvedAt, updatedAt: now })
      .where(eq(statusReports.id, reportId));
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

  async getPublicReportRows({ resolvedLimit }) {
    // One round-trip: the unresolved branch rides status_reports_ongoing
    // (partial on resolvedAt IS NULL) and the resolved branch the recency sort.
    const unresolved = db
      .select(reportSelection)
      .from(statusReports)
      .where(and(isNotNull(statusReports.publishedAt), isNull(statusReports.resolvedAt)))
      .orderBy(desc(statusReports.startsAt))
      .limit(100);
    const resolved = db
      .select(reportSelection)
      .from(statusReports)
      .where(and(isNotNull(statusReports.publishedAt), isNotNull(statusReports.resolvedAt)))
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
    return db
      .select(affectedSelection)
      .from(statusReportAffected)
      .where(inArray(statusReportAffected.reportId, [...reportIds]))
      .limit(2_000);
  },
};
