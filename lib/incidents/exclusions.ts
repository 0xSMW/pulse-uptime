import "server-only"

import { createHash } from "node:crypto"
import { and, asc, count, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm"
import { type DatabaseHandle, db } from "@/lib/db/client"
import {
  checkBatches,
  incidentExclusionChecks,
  incidentExclusions,
  incidents,
  metricRollups,
  monitorRegistry,
  monitorState,
} from "@/lib/db/schema"
import { decodeTelemetry } from "@/lib/storage/codec"

const MINUTE = 60_000
const floorMinute = (date: Date) =>
  new Date(Math.floor(date.getTime() / MINUTE) * MINUTE)
export interface ExclusionSlot {
  monitorId: string
  scheduledMinute: Date
  failed: boolean
  downtimeSeconds: number
}
export interface IncidentExclusionRecord {
  id: string
  incidentId: string
  monitorId: string
  startAt: string
  endAt: string
  reason: string
  createdByPrincipal: string
  createdAt: string
  revertedAt: string | null
  revertedByPrincipal: string | null
  affectedFailedChecks: number
}
interface Availability {
  expectedChecks: number
  completedChecks: number
  successfulChecks: number
  failedChecks: number
  unknownChecks: number
  excludedFailedChecks: number
  uptime: number | null
}
export interface IncidentExclusionPreview {
  incidentId: string
  monitorId: string
  startAt: string
  endAt: string
  affectedFailedChecks: number
  windowStart: string
  windowEnd: string
  before: Availability
  after: Availability
  previewVersion: string
}
export class IncidentExclusionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "IncidentExclusionError"
  }
}
const unavailable = () =>
  new IncidentExclusionError(
    "EXCLUSION_EVIDENCE_UNAVAILABLE",
    "Complete scheduled check evidence is unavailable"
  )

export async function loadExclusionSlots(
  monitorIds: string[],
  start: Date,
  end: Date,
  handle: DatabaseHandle = db
): Promise<ExclusionSlot[]> {
  if (!monitorIds.length) {
    return []
  }
  return handle
    .select({
      monitorId: incidentExclusionChecks.monitorId,
      scheduledMinute: incidentExclusionChecks.scheduledMinute,
      failed: incidentExclusionChecks.failed,
      downtimeSeconds: sql<number>`case when ${incidents.openedAt} < ${incidentExclusionChecks.scheduledMinute} + interval '1 minute'
        and (${incidents.resolvedAt} is null or ${incidents.resolvedAt} > ${incidentExclusionChecks.scheduledMinute})
        then ${incidentExclusionChecks.downtimeSeconds} else 0 end`,
    })
    .from(incidentExclusionChecks)
    .innerJoin(
      incidentExclusions,
      eq(incidentExclusions.id, incidentExclusionChecks.exclusionId)
    )
    .innerJoin(incidents, eq(incidents.id, incidentExclusions.incidentId))
    .where(
      and(
        inArray(incidentExclusionChecks.monitorId, monitorIds),
        gte(incidentExclusionChecks.scheduledMinute, start),
        lt(incidentExclusionChecks.scheduledMinute, end),
        isNull(incidentExclusions.revertedAt)
      )
    )
}

function serialize(
  row: typeof incidentExclusions.$inferSelect,
  affectedFailedChecks: number
): IncidentExclusionRecord {
  return {
    ...row,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    revertedAt: row.revertedAt?.toISOString() ?? null,
    affectedFailedChecks,
  }
}
export async function listIncidentExclusions(
  incidentId: string,
  handle: DatabaseHandle = db
): Promise<IncidentExclusionRecord[]> {
  const rows = await handle
    .select()
    .from(incidentExclusions)
    .where(eq(incidentExclusions.incidentId, incidentId))
    .orderBy(asc(incidentExclusions.createdAt))
  return Promise.all(
    rows.map(async (row) => {
      const [summary] = await handle
        .select({ value: count() })
        .from(incidentExclusionChecks)
        .where(
          and(
            eq(incidentExclusionChecks.exclusionId, row.id),
            eq(incidentExclusionChecks.failed, true)
          )
        )
      return serialize(row, Number(summary?.value ?? 0))
    })
  )
}

async function incidentFor(id: string, handle: DatabaseHandle) {
  const [row] = await handle
    .select()
    .from(incidents)
    .where(eq(incidents.id, id))
    .limit(1)
  if (!row) {
    throw new IncidentExclusionError(
      "INCIDENT_NOT_FOUND",
      "Incident was not found",
      404
    )
  }
  return row
}

async function evidence(
  monitorId: string,
  start: Date,
  end: Date,
  handle: DatabaseHandle
) {
  const batches = await handle
    .select()
    .from(checkBatches)
    .where(
      and(
        gte(checkBatches.scheduledMinute, start),
        lt(checkBatches.scheduledMinute, end)
      )
    )
    .orderBy(asc(checkBatches.scheduledMinute))
  return batches.map((batch) => {
    try {
      const values = decodeTelemetry({
        ...batch,
        monitorCount: batch.monitorIds.length,
      })
      const index = batch.monitorIds.indexOf(monitorId)
      return {
        scheduledMinute: batch.scheduledMinute,
        value: index < 0 ? null : values[index]!,
        schedulerCompleted: batch.schedulerCompletedAt !== null,
      }
    } catch (cause) {
      // biome-ignore lint/style/useErrorCause: custom domain error takes ErrorOptions as its fourth argument
      throw new IncidentExclusionError(
        "EXCLUSION_EVIDENCE_UNAVAILABLE",
        "Complete scheduled check evidence is unavailable",
        409,
        { cause }
      )
    }
  })
}
function withUptime(
  value: Omit<Availability, "uptime" | "excludedFailedChecks">,
  excludedFailedChecks: number
): Availability {
  const eligibleChecks = value.completedChecks - excludedFailedChecks
  return {
    ...value,
    excludedFailedChecks,
    uptime:
      eligibleChecks > 0
        ? (100 * value.successfulChecks) / eligibleChecks
        : null,
  }
}

async function calculate(
  id: string,
  range: { startAt?: string; endAt?: string },
  handle: DatabaseHandle
) {
  const incident = await incidentFor(id, handle)
  const earliest = floorMinute(incident.firstFailureAt)
  const [latest] = await handle
    .select({ minute: checkBatches.scheduledMinute })
    .from(checkBatches)
    .where(sql`${checkBatches.schedulerCompletedAt} is not null
      and ${incident.monitorId} = any(${checkBatches.monitorIds})
      and (get_byte(${checkBatches.expectedBitmap}, ((array_position(${checkBatches.monitorIds}, ${incident.monitorId}) - 1) / 8)::integer) >> ((array_position(${checkBatches.monitorIds}, ${incident.monitorId}) - 1) % 8)) & 1 = 1
      and (get_byte(${checkBatches.completedBitmap}, ((array_position(${checkBatches.monitorIds}, ${incident.monitorId}) - 1) / 8)::integer) >> ((array_position(${checkBatches.monitorIds}, ${incident.monitorId}) - 1) % 8)) & 1 = 1`)
    .orderBy(sql`${checkBatches.scheduledMinute} desc`)
    .limit(1)
  const latestEnd = incident.resolvedAt
    ? new Date(Math.ceil(incident.resolvedAt.getTime() / MINUTE) * MINUTE)
    : latest
      ? new Date(latest.minute.getTime() + MINUTE)
      : earliest
  const start = range.startAt ? new Date(range.startAt) : earliest
  const end = range.endAt ? new Date(range.endAt) : latestEnd
  if (
    ![start, end].every(
      (date) => Number.isFinite(date.getTime()) && date.getTime() % MINUTE === 0
    ) ||
    start >= end ||
    start < earliest ||
    end > latestEnd ||
    end.getTime() - start.getTime() > 90 * 86_400_000
  ) {
    throw new IncidentExclusionError(
      "INVALID_EXCLUSION_RANGE",
      "Choose complete minutes within the incident",
      400
    )
  }
  const selected = await evidence(incident.monitorId, start, end, handle)
  // Missing scheduler rows could mean a gap or purged evidence. Neither can be guessed.
  if (
    selected.length !== (end.getTime() - start.getTime()) / MINUTE ||
    selected.some((slot) => !slot.schedulerCompleted)
  ) {
    throw unavailable()
  }
  const slots: ExclusionSlot[] = selected
    .filter((slot) => slot.value?.expected)
    .map((slot) => ({
      monitorId: incident.monitorId,
      scheduledMinute: slot.scheduledMinute,
      failed: Boolean(
        slot.value?.expected && slot.value.completed && slot.value.failed
      ),
      downtimeSeconds:
        incident.openedAt.getTime() < slot.scheduledMinute.getTime() + MINUTE &&
        (!incident.resolvedAt || incident.resolvedAt > slot.scheduledMinute)
          ? 60
          : 0,
    }))
  if (!slots.some((slot) => slot.failed)) {
    throw new IncidentExclusionError(
      "EXCLUSION_NO_FAILED_CHECKS",
      "No failed checks in this interval"
    )
  }
  const active = await handle
    .select()
    .from(incidentExclusions)
    .where(
      and(
        eq(incidentExclusions.monitorId, incident.monitorId),
        isNull(incidentExclusions.revertedAt)
      )
    )
  if (
    active.some(
      (row) => row.incidentId === id || (row.startAt < end && row.endAt > start)
    )
  ) {
    throw new IncidentExclusionError(
      "EXCLUSION_OVERLAP",
      "An active exclusion already covers this interval"
    )
  }
  const windowEnd = new Date(Math.floor(Date.now() / 900_000) * 900_000)
  const windowStart = new Date(windowEnd.getTime() - 86_400_000)
  const [state] = await handle
    .select({ activatedAt: monitorState.activatedAt })
    .from(monitorState)
    .where(eq(monitorState.monitorId, incident.monitorId))
  const activation = state?.activatedAt?.getTime() ?? Number.POSITIVE_INFINITY
  const rollups = await handle
    .select()
    .from(metricRollups)
    .where(
      and(
        eq(metricRollups.monitorId, incident.monitorId),
        eq(metricRollups.resolution, "15m"),
        gte(metricRollups.bucketStart, windowStart),
        lt(metricRollups.bucketStart, windowEnd)
      )
    )
  const covered = new Set(rollups.map((row) => row.bucketStart.getTime()))
  const totals = {
    expectedChecks: 0,
    completedChecks: 0,
    successfulChecks: 0,
    failedChecks: 0,
    unknownChecks: 0,
  }
  for (const row of rollups.filter(
    (candidate) => candidate.bucketStart.getTime() >= activation
  )) {
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[key] += row[key]
    }
  }
  const raw = await evidence(incident.monitorId, windowStart, windowEnd, handle)
  for (const slot of raw) {
    const bucket =
      Math.floor(slot.scheduledMinute.getTime() / 900_000) * 900_000
    if (bucket < activation || covered.has(bucket) || !slot.value?.expected) {
      continue
    }
    totals.expectedChecks += 1
    if (slot.value.completed) {
      totals.completedChecks += 1
      if (slot.value.failed) {
        totals.failedChecks += 1
      } else {
        totals.successfulChecks += 1
      }
    } else {
      totals.unknownChecks += 1
    }
  }
  const existing = await loadExclusionSlots(
    [incident.monitorId],
    windowStart,
    windowEnd,
    handle
  )
  const eligible = (slot: ExclusionSlot) =>
    slot.failed &&
    slot.scheduledMinute >= windowStart &&
    slot.scheduledMinute < windowEnd &&
    Math.floor(slot.scheduledMinute.getTime() / 900_000) * 900_000 >= activation
  const existingCount = existing.filter(eligible).length
  const newlyExcluded = slots.filter(eligible).length
  const before = withUptime(totals, existingCount)
  const after = withUptime(totals, existingCount + newlyExcluded)
  const previewVersion = createHash("sha256")
    .update(
      JSON.stringify({
        id,
        start,
        end,
        incident,
        selected,
        active,
        windowStart,
        windowEnd,
        before,
        after,
      })
    )
    .digest("hex")
  const preview: IncidentExclusionPreview = {
    incidentId: id,
    monitorId: incident.monitorId,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    affectedFailedChecks: slots.filter((slot) => slot.failed).length,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    before,
    after,
    previewVersion,
  }
  return { preview, slots }
}
export async function previewIncidentExclusion(
  id: string,
  range: { startAt?: string; endAt?: string } = {},
  handle: DatabaseHandle = db
): Promise<IncidentExclusionPreview> {
  return (await calculate(id, range, handle)).preview
}

async function lockMonitor(incidentId: string, handle: DatabaseHandle) {
  const incident = await incidentFor(incidentId, handle)
  await handle
    .select({ id: monitorRegistry.id })
    .from(monitorRegistry)
    .where(eq(monitorRegistry.id, incident.monitorId))
    .for("update")
}
export async function applyIncidentExclusion(
  id: string,
  input: {
    startAt: string
    endAt: string
    reason: string
    previewVersion: string
  },
  principalKey: string,
  operationId: string,
  handle: DatabaseHandle
): Promise<IncidentExclusionRecord> {
  const reason = input.reason.trim()
  if (!reason || reason.length > 1000) {
    throw new IncidentExclusionError(
      "INVALID_EXCLUSION_REASON",
      "Enter a reason up to 1000 characters",
      400
    )
  }
  await lockMonitor(id, handle)
  const { preview, slots } = await calculate(id, input, handle)
  if (preview.previewVersion !== input.previewVersion) {
    throw new IncidentExclusionError(
      "EXCLUSION_PREVIEW_CHANGED",
      "Check evidence changed. Preview again"
    )
  }
  const [row] = await handle
    .insert(incidentExclusions)
    .values({
      id: operationId,
      incidentId: id,
      monitorId: preview.monitorId,
      startAt: new Date(preview.startAt),
      endAt: new Date(preview.endAt),
      reason,
      createdByPrincipal: principalKey,
      createdAt: new Date(),
    })
    .returning()
  // Only overlay and audit rows change. No telemetry or operational state is rewritten.
  for (let index = 0; index < slots.length; index += 1000) {
    await handle
      .insert(incidentExclusionChecks)
      .values(
        slots
          .slice(index, index + 1000)
          .map((slot) => ({ ...slot, exclusionId: operationId }))
      )
  }
  return serialize(row!, preview.affectedFailedChecks)
}
export async function undoIncidentExclusion(
  incidentId: string,
  exclusionId: string,
  principalKey: string,
  handle: DatabaseHandle
): Promise<IncidentExclusionRecord> {
  await lockMonitor(incidentId, handle)
  const rows = await listIncidentExclusions(incidentId, handle)
  const row = rows.find((item) => item.id === exclusionId)
  if (!row) {
    throw new IncidentExclusionError(
      "EXCLUSION_NOT_FOUND",
      "Exclusion was not found",
      404
    )
  }
  if (row.revertedAt) {
    return row
  }
  const revertedAt = new Date()
  await handle
    .update(incidentExclusions)
    .set({ revertedAt, revertedByPrincipal: principalKey })
    .where(
      and(
        eq(incidentExclusions.id, exclusionId),
        isNull(incidentExclusions.revertedAt)
      )
    )
  return {
    ...row,
    revertedAt: revertedAt.toISOString(),
    revertedByPrincipal: principalKey,
  }
}

export async function loadIncidentExclusionStatuses(
  ids: string[],
  handle: DatabaseHandle = db
): Promise<Map<string, "full" | "partial">> {
  if (!ids.length) {
    return new Map()
  }
  const rows = await handle
    .select({
      id: incidents.id,
      firstFailureAt: incidents.firstFailureAt,
      resolvedAt: incidents.resolvedAt,
      startAt: incidentExclusions.startAt,
      endAt: incidentExclusions.endAt,
    })
    .from(incidentExclusions)
    .innerJoin(incidents, eq(incidents.id, incidentExclusions.incidentId))
    .where(
      and(inArray(incidents.id, ids), isNull(incidentExclusions.revertedAt))
    )
  return new Map(
    rows.map((row) => [
      row.id,
      row.resolvedAt &&
      row.startAt.getTime() <=
        Math.floor(row.firstFailureAt.getTime() / MINUTE) * MINUTE &&
      row.endAt.getTime() >=
        Math.ceil(row.resolvedAt.getTime() / MINUTE) * MINUTE
        ? "full"
        : "partial",
    ])
  )
}
