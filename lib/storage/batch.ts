import { createHash } from "node:crypto";

import { deterministicUuid } from "@/lib/ids/deterministic-uuid";

import { encodeTelemetry } from "./codec";

export interface PackedMinuteExecutor {
  query<T>(text: string, values: readonly unknown[]): Promise<readonly T[]>;
}

export type MinuteCheckResult = {
  monitorId: string;
  completed: boolean;
  failed: boolean;
  latencyMs: number | null;
  errorCode?: string | null;
  incidentId?: string | null;
  recovered?: boolean;
};

export type PackedMinuteInput = {
  scheduledMinute: Date;
  configVersion: number;
  monitorIds: readonly string[];
  expectedMonitorIds: readonly string[];
  results: readonly MinuteCheckResult[];
  schedulerStartedAt: Date;
  schedulerCompletedAt: Date;
};

type ExceptionRow = {
  id: string;
  monitorId: string | null;
  eventType: "failure" | "recovery" | "scheduler_gap";
  errorCode: string | null;
  identityHash: string;
  seenAt: string;
  latencyMs: number | null;
  incidentId: string | null;
};

// $11 is bound as text then cast to jsonb. A param described as jsonb makes
// postgres.js JSON-encode the already-serialized string again, producing a
// double-encoded scalar jsonb_to_recordset can't read as an array.
export const WRITE_PACKED_MINUTE_SQL = `
with batch_insert as (
  insert into check_batches (
    scheduled_minute, encoding_version, config_version, monitor_ids,
    expected_bitmap, completed_bitmap, failure_bitmap, latency_values,
    scheduler_started_at, scheduler_completed_at, created_at
  ) values ($1, $2, $3, $4::text[], $5::bytea, $6::bytea, $7::bytea, $8::bytea, $9, $10, $10)
  on conflict (scheduled_minute) do nothing
  returning scheduled_minute
), exception_rows as (
  select * from jsonb_to_recordset($11::text::jsonb) as event(
    id uuid, "monitorId" text, "eventType" text, "errorCode" text,
    "identityHash" text, "seenAt" timestamptz, "latencyMs" integer, "incidentId" uuid
  )
)
insert into monitor_exceptions (
  id, monitor_id, event_type, error_code, identity_hash, first_seen_at,
  last_seen_at, occurrence_count, worst_latency_ms, incident_id
)
select id, "monitorId", "eventType", "errorCode", decode("identityHash", 'hex'),
  "seenAt", "seenAt", 1, "latencyMs", "incidentId"
from exception_rows cross join batch_insert
on conflict (monitor_id, event_type, identity_hash, (coalesce(incident_id, '00000000-0000-0000-0000-000000000000'::uuid)))
do update set
  last_seen_at = greatest(monitor_exceptions.last_seen_at, excluded.last_seen_at),
  first_seen_at = least(monitor_exceptions.first_seen_at, excluded.first_seen_at),
  occurrence_count = monitor_exceptions.occurrence_count + 1,
  worst_latency_ms = greatest(monitor_exceptions.worst_latency_ms, excluded.worst_latency_ms)
`;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writePackedMinute(db: PackedMinuteExecutor, input: PackedMinuteInput): Promise<void> {
  const orderedMonitorIds = [...new Set(input.monitorIds)].sort();
  const expected = new Set(input.expectedMonitorIds);
  const byMonitor = new Map(input.results.map((result) => [result.monitorId, result]));
  const packed = encodeTelemetry(orderedMonitorIds.map((monitorId) => {
    const result = byMonitor.get(monitorId);
    return {
      expected: expected.has(monitorId),
      completed: result?.completed ?? false,
      failed: result?.failed ?? false,
      latencyMs: result?.completed ? result.latencyMs : null,
    };
  }));
  const minute = input.scheduledMinute.toISOString();
  const exceptions = orderedMonitorIds.flatMap<ExceptionRow>((monitorId) => {
    const result = byMonitor.get(monitorId);
    if (!result?.completed && expected.has(monitorId)) {
      const identity = `scheduler_gap/${monitorId}/${minute}`;
      return [{
        id: deterministicUuid(identity), monitorId, eventType: "scheduler_gap" as const,
        errorCode: "SCHEDULED_CHECK_MISSING", identityHash: digest(identity), seenAt: minute,
        latencyMs: null, incidentId: null,
      }];
    }
    if (!result?.completed) return [];
    if (result.failed) {
      const code = result.errorCode ?? "CHECK_FAILED";
      const identity = `failure/${monitorId}/${code}`;
      return [{
        id: deterministicUuid(`${identity}/${result.incidentId ?? "none"}`), monitorId,
        eventType: "failure" as const, errorCode: code, identityHash: digest(identity),
        seenAt: minute, latencyMs: result.latencyMs, incidentId: result.incidentId ?? null,
      }];
    }
    if (result.recovered) {
      const identity = `recovery/${monitorId}/${result.incidentId ?? minute}`;
      return [{
        id: deterministicUuid(identity), monitorId, eventType: "recovery" as const,
        errorCode: null, identityHash: digest(identity), seenAt: minute,
        latencyMs: result.latencyMs, incidentId: result.incidentId ?? null,
      }];
    }
    return [];
  });
  await db.query(WRITE_PACKED_MINUTE_SQL, [
    input.scheduledMinute,
    packed.encodingVersion,
    input.configVersion,
    orderedMonitorIds,
    packed.expectedBitmap,
    packed.completedBitmap,
    packed.failureBitmap,
    packed.latencyValues,
    input.schedulerStartedAt,
    input.schedulerCompletedAt,
    JSON.stringify(exceptions),
  ]);
}
