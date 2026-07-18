import { createHash } from "node:crypto";

import { incidentNotificationKey } from "@/lib/notifications/idempotency";
import { formatDuration } from "@/lib/reporting/format";
import { transitionMonitor } from "@/lib/monitoring/state-machine";
import type { MonitorStateSnapshot, ScheduledCheck } from "@/lib/monitoring/types";

import { encodeTelemetry } from "./codec";
import type { PackedMinuteExecutor } from "./batch";

export type CompletedMinuteCheck = Omit<ScheduledCheck, "runId" | "scheduledAt">;

export type AtomicMinuteInput = {
  scheduledMinute: Date;
  configVersion: number;
  monitorIds: readonly string[];
  expectedMonitorIds: readonly string[];
  results: readonly CompletedMinuteCheck[];
  states: ReadonlyMap<string, MonitorStateSnapshot>;
  schedulerStartedAt: Date;
  schedulerCompletedAt: Date;
};

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

export const PERSIST_ATOMIC_MINUTE_SQL = `
with batch_insert as materialized (
  insert into check_batches (
    scheduled_minute, encoding_version, config_version, monitor_ids,
    expected_bitmap, completed_bitmap, failure_bitmap, latency_values,
    scheduler_started_at, scheduler_completed_at, created_at
  ) values ($1, $2, $3, array(select jsonb_array_elements_text($4::jsonb)),
    decode($5, 'hex'), decode($6, 'hex'), decode($7, 'hex'), decode($8, 'hex'), $9, $10, $10)
  on conflict (scheduled_minute) do nothing returning scheduled_minute
), state_rows as materialized (
  select r.* from jsonb_to_recordset($11::jsonb) as r(
    "monitorId" text, "expectedVersion" integer, state text,
    "consecutiveFailures" integer, "consecutiveSuccesses" integer,
    "firstFailureAt" timestamptz, "firstSuccessAt" timestamptz,
    "lastCheckedAt" timestamptz, "lastSuccessAt" timestamptz,
    "lastFailureAt" timestamptz, "lastStatusCode" integer,
    "lastLatencyMs" integer, "lastErrorCode" text,
    "activeIncidentId" uuid, version integer, "updatedAt" timestamptz
  ) cross join batch_insert
), opened as (
  insert into incidents (id, monitor_id, opened_at, first_failure_at, last_failure_at,
    opening_error_code, opening_status_code, created_at, updated_at)
  select r.id, r."monitorId", r."openedAt", r."firstFailureAt", r."lastFailureAt",
    r."errorCode", r."statusCode", r."createdAt", r."createdAt"
  from jsonb_to_recordset($12::jsonb) as r(id uuid, "monitorId" text, "openedAt" timestamptz,
    "firstFailureAt" timestamptz, "lastFailureAt" timestamptz, "errorCode" text,
    "statusCode" integer, "createdAt" timestamptz) cross join batch_insert
  on conflict (id) do nothing returning id
), progressed as (
  update incidents set
    last_failure_at = coalesce(r."lastFailureAt", incidents.last_failure_at),
    first_success_at = case when r."clearFirstSuccess" then null else coalesce(r."firstSuccessAt", incidents.first_success_at) end,
    updated_at = r."updatedAt"
  from jsonb_to_recordset($13::jsonb) as r(id uuid, "lastFailureAt" timestamptz,
    "firstSuccessAt" timestamptz, "clearFirstSuccess" boolean, "updatedAt" timestamptz), batch_insert
  where incidents.id = r.id and incidents.resolved_at is null returning incidents.id
), resolved as (
  update incidents set first_success_at = r."firstSuccessAt", resolved_at = r."firstSuccessAt",
    resolution_reason = 'recovered', updated_at = r."updatedAt"
  from jsonb_to_recordset($14::jsonb) as r(id uuid, "firstSuccessAt" timestamptz, "updatedAt" timestamptz), batch_insert
  where incidents.id = r.id and incidents.resolved_at is null returning incidents.id
), outbox_insert as (
  insert into notification_outbox (id, incident_id, monitor_id, event_type, recipient,
    idempotency_key, payload, status, attempt_count, next_attempt_at, created_at, updated_at)
  select r.id, r."incidentId", r."monitorId", r."eventType", r.recipient,
    r."idempotencyKey", r.payload, 'pending', 0, r."createdAt", r."createdAt", r."createdAt"
  from jsonb_to_recordset($15::jsonb) as r(id uuid, "incidentId" uuid, "monitorId" text,
    "eventType" text, recipient text, "idempotencyKey" text, payload jsonb,
    "createdAt" timestamptz, "requiresOpen" boolean) cross join batch_insert
  where not r."requiresOpen" or exists (select 1 from opened where opened.id = r."incidentId")
  on conflict (idempotency_key) do nothing returning id
), payload_insert as (
  insert into exception_payloads (id, payload, created_at, expires_at)
  select r.id, r.payload, r."createdAt", r."expiresAt"
  from jsonb_to_recordset($16::jsonb) as r(id uuid, payload jsonb, "createdAt" timestamptz, "expiresAt" timestamptz)
  cross join batch_insert on conflict (id) do nothing returning id
), exception_insert as (
  insert into monitor_exceptions (id, monitor_id, event_type, error_code, identity_hash,
    first_seen_at, last_seen_at, occurrence_count, worst_latency_ms, incident_id, payload_id)
  select r.id, r."monitorId", r."eventType", r."errorCode", decode(r."identityHash", 'hex'),
    r."seenAt", r."seenAt", 1, r."latencyMs", r."incidentId", r."payloadId"
  from jsonb_to_recordset($17::jsonb) as r(id uuid, "monitorId" text, "eventType" text,
    "errorCode" text, "identityHash" text, "seenAt" timestamptz, "latencyMs" integer,
    "incidentId" uuid, "payloadId" uuid) cross join batch_insert
  left join payload_insert on payload_insert.id = r."payloadId"
  where r."payloadId" is null or payload_insert.id is not null
  on conflict (monitor_id, event_type, identity_hash, (coalesce(incident_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  do update set first_seen_at = least(monitor_exceptions.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(monitor_exceptions.last_seen_at, excluded.last_seen_at),
    occurrence_count = monitor_exceptions.occurrence_count + 1,
    worst_latency_ms = case when monitor_exceptions.worst_latency_ms is null then excluded.worst_latency_ms
      when excluded.worst_latency_ms is null then monitor_exceptions.worst_latency_ms
      else greatest(monitor_exceptions.worst_latency_ms, excluded.worst_latency_ms) end,
    payload_id = coalesce(excluded.payload_id, monitor_exceptions.payload_id)
  returning id
), state_update as (
  update monitor_state set state = r.state,
    consecutive_failures = r."consecutiveFailures", consecutive_successes = r."consecutiveSuccesses",
    first_failure_at = r."firstFailureAt", first_success_at = r."firstSuccessAt",
    last_checked_at = r."lastCheckedAt", last_success_at = r."lastSuccessAt",
    last_failure_at = r."lastFailureAt", last_status_code = r."lastStatusCode",
    last_latency_ms = r."lastLatencyMs", last_error_code = r."lastErrorCode",
    active_incident_id = r."activeIncidentId", version = r.version, updated_at = r."updatedAt"
  from state_rows r
  where monitor_state.monitor_id = r."monitorId" and monitor_state.version = r."expectedVersion"
  returning monitor_state.monitor_id
)
insert into atomic_minute_commits (scheduled_minute, state_mutation_count, committed_at)
select batch_insert.scheduled_minute, (select count(*) from state_update), $10
from batch_insert
where pulse_assert_equal((select count(*) from state_update), (select count(*) from state_rows))
  and (select count(*) from opened) + (select count(*) from progressed) + (select count(*) from resolved)
    + (select count(*) from outbox_insert) + (select count(*) from exception_insert) >= 0
`;

export async function persistAtomicMinute(db: PackedMinuteExecutor, input: AtomicMinuteInput): Promise<void> {
  const monitorIds = [...new Set(input.monitorIds)].sort();
  if (monitorIds.length !== input.monitorIds.length) throw new Error("Duplicate monitor mapping");
  const expected = new Set(input.expectedMonitorIds);
  const results = new Map<string, CompletedMinuteCheck>();
  for (const result of input.results) {
    if (results.has(result.monitorId)) throw new Error(`Duplicate minute result: ${result.monitorId}`);
    if (!expected.has(result.monitorId)) throw new Error(`Unexpected minute result: ${result.monitorId}`);
    results.set(result.monitorId, result);
  }
  const packed = encodeTelemetry(monitorIds.map((monitorId) => {
    const result = results.get(monitorId);
    return { expected: expected.has(monitorId), completed: Boolean(result), failed: result ? !result.successful : false, latencyMs: result?.latencyMs ?? null };
  }));
  const stateRows: unknown[] = [];
  const opened: unknown[] = [];
  const progressed: unknown[] = [];
  const resolved: unknown[] = [];
  const outbox: unknown[] = [];
  const payloads: unknown[] = [];
  const exceptions: unknown[] = [];
  const seenAt = input.scheduledMinute.toISOString();

  for (const monitorId of monitorIds) {
    const check = results.get(monitorId);
    if (!check) {
      if (expected.has(monitorId)) {
        const identity = `scheduler_gap/${monitorId}/${seenAt}`;
        exceptions.push({ id: deterministicUuid(identity), monitorId, eventType: "scheduler_gap", errorCode: "SCHEDULED_CHECK_MISSING", identityHash: createHash("sha256").update(identity).digest("hex"), seenAt, latencyMs: null, incidentId: null, payloadId: null });
      }
      continue;
    }
    const current = input.states.get(monitorId);
    if (!current) throw new Error(`Monitor state not found: ${monitorId}`);
    const transition = transitionMonitor(current, {
      type: "check", checkedAt: check.checkedAt, successful: check.successful,
      statusCode: check.statusCode, latencyMs: check.latencyMs, errorCode: check.errorCode,
      failureThreshold: check.failureThreshold, recoveryThreshold: check.recoveryThreshold,
    });
    if (transition.state !== current) {
      let incidentId = transition.state.activeIncidentId;
      if (transition.incident?.type === "open") {
        incidentId = deterministicUuid(`incident/${monitorId}/${transition.incident.firstFailureAt.toISOString()}`);
        transition.state.activeIncidentId = incidentId;
        opened.push({ id: incidentId, monitorId, openedAt: iso(transition.incident.openedAt), firstFailureAt: iso(transition.incident.firstFailureAt), lastFailureAt: iso(check.checkedAt), errorCode: check.errorCode, statusCode: check.statusCode, createdAt: iso(check.checkedAt) });
      } else if (transition.incident?.type === "resolve") {
        incidentId = transition.incident.incidentId;
        resolved.push({ id: incidentId, firstSuccessAt: iso(transition.incident.firstSuccessAt), updatedAt: iso(check.checkedAt) });
      } else if (incidentId && !check.successful && ["DOWN", "VERIFYING_UP"].includes(transition.previousState)) {
        progressed.push({ id: incidentId, lastFailureAt: iso(check.checkedAt), firstSuccessAt: null, clearFirstSuccess: true, updatedAt: iso(check.checkedAt) });
      } else if (incidentId && check.successful && transition.previousState === "DOWN" && transition.state.state === "VERIFYING_UP") {
        progressed.push({ id: incidentId, lastFailureAt: null, firstSuccessAt: iso(transition.state.firstSuccessAt), clearFirstSuccess: false, updatedAt: iso(check.checkedAt) });
      }
      stateRows.push({ ...transition.state, monitorId, expectedVersion: current.version,
        firstFailureAt: iso(transition.state.firstFailureAt), firstSuccessAt: iso(transition.state.firstSuccessAt),
        lastCheckedAt: iso(transition.state.lastCheckedAt), lastSuccessAt: iso(transition.state.lastSuccessAt),
        lastFailureAt: iso(transition.state.lastFailureAt), updatedAt: iso(transition.state.updatedAt) });

      if (transition.incident && incidentId) {
        const event = transition.incident.type === "open" ? "opened" : "resolved";
        const recipients = [...new Set(check.recipients.map((recipient) => recipient.trim().toLowerCase()))].sort();
        for (const recipient of recipients) {
          const idempotencyKey = incidentNotificationKey(incidentId, event, recipient);
          const payload = transition.incident.type === "open"
            ? { type: "incident.opened", monitorName: check.monitorName, incidentId, startedAt: iso(transition.incident.openedAt), cause: check.errorMessage ?? (check.statusCode ? `HTTP ${check.statusCode}` : check.errorCode ?? "Check failed") }
            : { type: "incident.resolved", monitorName: check.monitorName, incidentId, recoveredAt: iso(transition.incident.firstSuccessAt), duration: formatDuration((transition.incident.firstSuccessAt.getTime() - transition.incident.openedAt.getTime()) / 1_000) };
          outbox.push({ id: deterministicUuid(`outbox/${idempotencyKey}`), incidentId, monitorId, eventType: `incident.${event}`, recipient, idempotencyKey, payload, createdAt: iso(check.checkedAt), requiresOpen: event === "opened" });
        }
      }
      if (transition.incident?.type === "resolve" && incidentId) {
        const identity = `recovery/${monitorId}/${incidentId}`;
        exceptions.push({ id: deterministicUuid(identity), monitorId, eventType: "recovery", errorCode: null, identityHash: createHash("sha256").update(identity).digest("hex"), seenAt, latencyMs: check.latencyMs, incidentId, payloadId: null });
      }
    }
    if (!check.successful) {
      const incidentId = transition.state.activeIncidentId;
      const code = check.errorCode ?? "CHECK_FAILED";
      const identity = `failure/${monitorId}/${code}`;
      const payloadId = deterministicUuid(`exception-payload/${monitorId}/${seenAt}`);
      payloads.push({ id: payloadId, payload: { statusCode: check.statusCode, latencyMs: check.latencyMs, errorCode: check.errorCode, errorMessage: check.errorMessage, checkedAt: check.checkedAt.toISOString(), effectiveUrl: check.effectiveUrl, redirectCount: check.redirectCount, resolvedAddress: check.resolvedAddress }, createdAt: iso(check.checkedAt), expiresAt: new Date(check.checkedAt.getTime() + 30 * 86_400_000).toISOString() });
      exceptions.push({ id: deterministicUuid(`${identity}/${incidentId ?? "none"}`), monitorId, eventType: "failure", errorCode: code, identityHash: createHash("sha256").update(identity).digest("hex"), seenAt, latencyMs: check.latencyMs, incidentId, payloadId });
    }
  }

  await db.query(PERSIST_ATOMIC_MINUTE_SQL, [input.scheduledMinute, packed.encodingVersion, input.configVersion,
    JSON.stringify(monitorIds), packed.expectedBitmap.toString("hex"), packed.completedBitmap.toString("hex"),
    packed.failureBitmap.toString("hex"), packed.latencyValues.toString("hex"),
    input.schedulerStartedAt, input.schedulerCompletedAt, JSON.stringify(stateRows), JSON.stringify(opened),
    JSON.stringify(progressed), JSON.stringify(resolved), JSON.stringify(outbox), JSON.stringify(payloads),
    JSON.stringify(exceptions)]);
}
