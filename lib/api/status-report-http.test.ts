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

import { revalidateStatusReportPaths, storedStatusReportError } from "./status-report-http";

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
    // via the ordinary completed-record path — work() never runs again, so
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
});
