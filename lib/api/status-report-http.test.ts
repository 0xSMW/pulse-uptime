import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/api/status-reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/status-reports")>();
  return {
    ...actual,
    databaseStatusReportsStore: { ...actual.databaseStatusReportsStore, findMonitors: vi.fn() },
  };
});

import { revalidatePath } from "next/cache";

import { errorEnvelope } from "@/lib/api/envelopes";
import { executeIdempotent, type IdempotencyPersistence, type IdempotencyRecord } from "@/lib/api/idempotency";
import { databaseStatusReportsStore, StatusReportError } from "@/lib/api/status-reports";

import { revalidateStatusReportPaths, statusReportPatchAlreadyApplied, storedStatusReportError } from "./status-report-http";

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(databaseStatusReportsStore.findMonitors).mockReset().mockResolvedValue([]);
});

describe("revalidateStatusReportPaths", () => {
  it("always revalidates the status root and the report permalink", async () => {
    await revalidateStatusReportPaths({ id: "rep-1", affected: [] });
    expect(revalidatePath).toHaveBeenCalledWith("/status");
    expect(revalidatePath).toHaveBeenCalledWith("/status/reports/rep-1");
  });

  it("revalidates the snapshotted group of newly affected monitors", async () => {
    await revalidateStatusReportPaths({
      id: "rep-1",
      affected: [{ monitorId: "mon-1", groupName: "Core" }],
    });
    expect(revalidatePath).toHaveBeenCalledWith("/status/core");
  });

  it("unions old and new affected monitor ids in the live findMonitors lookup (finding: removed monitors' live groups missed)", async () => {
    await revalidateStatusReportPaths(
      { id: "rep-1", affected: [{ monitorId: "mon-1", groupName: "Core" }] },
      [{ monitorId: "mon-2", groupName: "Data" }],
    );
    expect(databaseStatusReportsStore.findMonitors).toHaveBeenCalledWith(["mon-1", "mon-2"]);
  });

  it("revalidates a removed monitor's CURRENT live group, not just its stale snapshot", async () => {
    // mon-2 was removed from the affected set (only present in
    // previousAffected) but has since moved from "Data-Old" to "Data-New" in
    // the registry. Both the stale snapshot's page and the live page must
    // refresh so the report never lingers on a page it silently moved off.
    vi.mocked(databaseStatusReportsStore.findMonitors).mockResolvedValue([
      { id: "mon-2", name: "Database", groupName: "Data-New" },
    ]);
    await revalidateStatusReportPaths(
      { id: "rep-1", affected: [] },
      [{ monitorId: "mon-2", groupName: "Data-Old" }],
    );
    expect(databaseStatusReportsStore.findMonitors).toHaveBeenCalledWith(["mon-2"]);
    expect(revalidatePath).toHaveBeenCalledWith("/status/data-old");
    expect(revalidatePath).toHaveBeenCalledWith("/status/data-new");
  });

  it("is best-effort: a findMonitors failure never throws and the snapshot slugs still revalidate", async () => {
    vi.mocked(databaseStatusReportsStore.findMonitors).mockRejectedValue(new Error("db down"));
    await expect(revalidateStatusReportPaths({
      id: "rep-1",
      affected: [{ monitorId: "mon-1", groupName: "Core" }],
    })).resolves.toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith("/status/core");
  });

  it("never calls findMonitors when no monitor was ever affected", async () => {
    await revalidateStatusReportPaths({ id: "rep-1", affected: [] });
    expect(databaseStatusReportsStore.findMonitors).not.toHaveBeenCalled();
  });
});

describe("statusReportPatchAlreadyApplied (finding: an INVALID patch retry was recovered as a false 200)", () => {
  const current = {
    title: "API outage",
    startsAt: "2026-07-18T09:00:00.000Z",
    endsAt: null,
    affected: [{ monitorId: "api-prod", impact: "down" }],
  };

  it("returns false for an empty body — patchSchema requires at least one field", () => {
    expect(statusReportPatchAlreadyApplied(current, {})).toBe(false);
  });

  it("returns false for a body with only unsupported keys (fails patchSchema's .strict())", () => {
    expect(statusReportPatchAlreadyApplied(current, { foo: 1 })).toBe(false);
  });

  it("still returns true for a genuinely already-applied, schema-valid patch", () => {
    expect(statusReportPatchAlreadyApplied(current, { title: "API outage" })).toBe(true);
  });

  it("recovers a padded title against the schema-trimmed stored value (finding: comparing the raw body missed patchSchema's titleSchema.trim())", () => {
    // updateStatusReport parses the patch through patchSchema before
    // persisting, so `{ title: " API outage " }` is stored as "API outage".
    // A stale post-commit retry replaying the SAME raw, padded body must
    // still recover: comparing the raw field against the trimmed current
    // title would spuriously return false and rerun work().
    expect(statusReportPatchAlreadyApplied(current, { title: " API outage " })).toBe(true);
  });

  it("does not recover a genuinely different (non-whitespace) title", () => {
    expect(statusReportPatchAlreadyApplied(current, { title: "Different outage" })).toBe(false);
  });

  it("recovers a padded affected monitorId against the schema-trimmed stored value", () => {
    // affectedEntrySchema trims monitorId the same way titleSchema trims
    // title. A stale retry's raw, padded monitorId must still match the
    // current (already-trimmed) affected set.
    expect(
      statusReportPatchAlreadyApplied(current, { affected: [{ monitorId: " api-prod ", impact: "down" }] }),
    ).toBe(true);
  });
});

/** Minimal in-memory IdempotencyPersistence, mirroring lib/api/idempotency.test.ts. */
class MemoryPersistence implements IdempotencyPersistence {
  owner: IdempotencyRecord | undefined;

  async insertRunning(value: Parameters<IdempotencyPersistence["insertRunning"]>[0]) {
    if (this.owner) return undefined;
    this.owner = { responseStatus: null, responseBody: null, completedAt: null, ...value } as IdempotencyRecord;
    return this.owner.id;
  }

  async findOwner(principalKey: string, idempotencyKey: string) {
    return this.owner?.principalKey === principalKey && this.owner.idempotencyKey === idempotencyKey ? this.owner : undefined;
  }

  async reclaimExpired(id: string, now: Date, value: Parameters<IdempotencyPersistence["reclaimExpired"]>[2]) {
    if (!this.owner || this.owner.id !== id || this.owner.expiresAt > now) return null;
    this.owner = { responseStatus: null, responseBody: null, completedAt: null, ...value } as IdempotencyRecord;
    return this.owner.id;
  }

  async claimStale(id: string, staleBefore: Date, now: Date, expiresAt: Date) {
    if (!this.owner || this.owner.id !== id || this.owner.createdAt >= staleBefore) return undefined;
    this.owner = { ...this.owner, createdAt: now, expiresAt };
    return id;
  }

  async complete(id: string, status: number, body: unknown, completedAt: Date) {
    if (!this.owner || this.owner.id !== id) return;
    this.owner = { ...this.owner, state: "completed", responseStatus: status, responseBody: body, completedAt };
  }
}

function idempotentRequest() {
  return new Request("https://pulse.test/api/v1/status-reports/rep-1/publish", {
    method: "POST",
    headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000001" },
  });
}

describe("storedStatusReportError + executeIdempotent (finding: publish/report-delete/update-delete threw their deterministic 409/404s past executeIdempotent, leaving the idempotency record stuck 'running' until a stale reclaim's recover callback saw the exact state the failure described and replayed it as a false 200)", () => {
  it("records a genuine conflict inside work() and replays it verbatim on retry, instead of a recover callback manufacturing success", async () => {
    const persistence = new MemoryPersistence();
    const work = vi.fn(async () => {
      try {
        throw new StatusReportError("ALREADY_PUBLISHED", "The status report is already published");
      } catch (error) {
        if (error instanceof StatusReportError) return storedStatusReportError(error, "req-1");
        throw error;
      }
    });

    const first = await executeIdempotent({
      request: idempotentRequest(), principalKey: "human:1", routeKey: "test", body: {}, persistence, work,
    });
    expect(first).toMatchObject({ status: 409, replayed: false });
    expect(first.body).toEqual(errorEnvelope("ALREADY_PUBLISHED", "The status report is already published", "req-1", {}));

    // Retry with the SAME idempotency key: replays the recorded 409 verbatim
    // via the ordinary completed-record path, work() never runs again, so
    // there's no recover callback in the loop to manufacture a false success.
    const second = await executeIdempotent({
      request: idempotentRequest(), principalKey: "human:1", routeKey: "test", body: {}, persistence, work,
    });
    expect(work).toHaveBeenCalledOnce();
    expect(second).toEqual({ ...first, replayed: true });
  });

  it("still replays a genuine success on retry, with no recover callback needed", async () => {
    const persistence = new MemoryPersistence();
    const work = vi.fn(async () => ({ status: 200, body: { ok: true } }));

    const first = await executeIdempotent({
      request: idempotentRequest(), principalKey: "human:1", routeKey: "test", body: {}, persistence, work,
    });
    expect(first).toMatchObject({ status: 200, body: { ok: true }, replayed: false });

    const second = await executeIdempotent({
      request: idempotentRequest(), principalKey: "human:1", routeKey: "test", body: {}, persistence, work,
    });
    expect(work).toHaveBeenCalledOnce();
    expect(second).toMatchObject({ status: 200, body: { ok: true }, replayed: true });
  });

  it("mirrors POST /api/v1/incidents/{id}/promote: promoting an unknown incident records a 404 and a retry replays it, instead of leaving the record stuck 'running' with no recover callback to fall back on", async () => {
    const persistence = new MemoryPersistence();
    const work = vi.fn(async () => {
      try {
        throw new StatusReportError("INCIDENT_NOT_FOUND", "Incident was not found");
      } catch (error) {
        if (error instanceof StatusReportError) return storedStatusReportError(error, "req-1");
        throw error;
      }
    });

    const first = await executeIdempotent({
      request: idempotentRequest(), principalKey: "human:1", routeKey: "test-promote", body: {}, persistence, work,
    });
    expect(first).toMatchObject({ status: 404, replayed: false });
    expect(first.body).toEqual(errorEnvelope("INCIDENT_NOT_FOUND", "Incident was not found", "req-1", {}));

    // Retry with the same key: replays the recorded 404 verbatim via the
    // ordinary completed-record path. Without catching this inside work(),
    // the record would stay "running" and a retry within the 5-minute stale
    // window would hit REQUEST_IN_PROGRESS (there's no recover callback for
    // promote to fall back on) instead of this clean, replayed 404.
    const second = await executeIdempotent({
      request: idempotentRequest(), principalKey: "human:1", routeKey: "test-promote", body: {}, persistence, work,
    });
    expect(work).toHaveBeenCalledOnce();
    expect(second).toEqual({ ...first, replayed: true });
  });
});

describe("statusReportPatchAlreadyApplied + executeIdempotent: a stale retry of an INVALID patch reproduces the genuine 400, never a false 200", () => {
  const CURRENT = {
    title: "API outage",
    startsAt: "2026-07-18T09:00:00.000Z",
    endsAt: null as string | null,
    affected: [] as Array<{ monitorId: string; impact: string }>,
  };

  function patchRequest(body: unknown) {
    return new Request("https://pulse.test/api/v1/status-reports/rep-1", {
      method: "PATCH",
      headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000002" },
      body: JSON.stringify(body),
    });
  }

  /** Mirrors the route's work(): an invalid patch throws VALIDATION_ERROR, caught and recorded via storedStatusReportError instead of thrown past executeIdempotent. */
  const invalidPatchWork = async () => {
    try {
      throw new StatusReportError("VALIDATION_ERROR", "Provide at least one field to update");
    } catch (error) {
      if (error instanceof StatusReportError) return storedStatusReportError(error, "req-1");
      throw error;
    }
  };

  async function staleRetryReproducesGenuine400(body: unknown) {
    const persistence = new MemoryPersistence();
    const firstNow = new Date("2026-07-18T12:00:00.000Z");
    const staleNow = new Date(firstNow.getTime() + 6 * 60_000); // past the 5-minute stale threshold

    // First attempt: simulate a genuine crash mid-request: work() never
    // returns, so complete() never persists a response, leaving the record
    // stuck "running" with the real computed request hash.
    await expect(executeIdempotent({
      request: patchRequest(body), principalKey: "human:1", routeKey: "test-patch", body, persistence, now: firstNow,
      work: async () => { throw new Error("simulated crash"); },
    })).rejects.toThrow("simulated crash");
    expect(persistence.owner?.state).toBe("running");

    // Stale retry, same Idempotency-Key + body, 6+ minutes later: recover()
    // must see the patch fails patchSchema and return null instead of
    // falling through to `true` (no recognized field mismatched a body with
    // no recognized fields at all), so work() reruns and reproduces the
    // real 400, rather than a recover callback manufacturing a false 200.
    const retried = await executeIdempotent({
      request: patchRequest(body), principalKey: "human:1", routeKey: "test-patch", body, persistence, now: staleNow,
      recover: async () => (statusReportPatchAlreadyApplied(CURRENT, body) ? { status: 200, body: { ok: true } } : null),
      work: invalidPatchWork,
    });
    expect(retried.status).toBe(400);
    expect(retried.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  }

  it("stale retry of {} replays a genuine 400", async () => {
    await staleRetryReproducesGenuine400({});
  });

  it("stale retry of {foo:1} (unsupported key) replays a genuine 400", async () => {
    await staleRetryReproducesGenuine400({ foo: 1 });
  });

  it("stale retry of a padded title recovers a 200 without rerunning work() (finding: comparing the raw body missed patchSchema's trim, so a genuinely-applied padded-title patch replay spuriously reran work() and re-snapshotted affected monitors a second time)", async () => {
    const persistence = new MemoryPersistence();
    const firstNow = new Date("2026-07-18T12:00:00.000Z");
    const staleNow = new Date(firstNow.getTime() + 6 * 60_000); // past the 5-minute stale threshold
    const body = { title: " API outage " };

    // First attempt: the patch DID commit (title persisted trimmed as
    // "API outage"), but the response never made it back (simulated here as
    // a thrown error after the record was inserted, same as the other tests
    // in this file), leaving the record stuck "running".
    await expect(executeIdempotent({
      request: patchRequest(body), principalKey: "human:1", routeKey: "test-patch", body, persistence, now: firstNow,
      work: async () => { throw new Error("simulated crash after commit"); },
    })).rejects.toThrow("simulated crash after commit");
    expect(persistence.owner?.state).toBe("running");

    const work = vi.fn(invalidPatchWork);
    const retried = await executeIdempotent({
      request: patchRequest(body), principalKey: "human:1", routeKey: "test-patch", body, persistence, now: staleNow,
      recover: async () => (statusReportPatchAlreadyApplied(CURRENT, body) ? { status: 200, body: { ok: true } } : null),
      work,
    });

    expect(retried).toMatchObject({ status: 200, body: { ok: true }, replayed: true });
    expect(work).not.toHaveBeenCalled();
  });
});
