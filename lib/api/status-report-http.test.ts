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
vi.mock("@/lib/api/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/idempotency")>()),
  executeIdempotent: vi.fn(),
}));

import { revalidatePath } from "next/cache";

import type { DatabaseHandle } from "@/lib/db/client";
import { executeIdempotent, type IdempotencyContext } from "@/lib/api/idempotency";
import { databaseStatusReportsStore, StatusReportError } from "@/lib/api/status-reports";

import { revalidateStatusReportPaths, runStatusReportMutation } from "./status-report-http";

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

function mutationRequest() {
  return new Request("https://pulse.test/api/v1/status-reports/rep-1/publish", {
    method: "POST",
    headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000001" },
  });
}

/**
 * executeIdempotent itself is mocked here (mirroring every route.test.ts in
 * this family): the fake stands in for the real acquire/replay machinery
 * (already exhaustively covered in lib/api/idempotency.test.ts) and instead
 * models just the ONE contract runStatusReportMutation's doc comment is
 * about: context.transaction runs `run` against a transaction handle and
 * only records a completion (into `completions`, standing in for the DB
 * write) if `run` resolves. If `run` throws, nothing is pushed, mirroring a
 * rolled-back transaction leaving the record running.
 */
describe("runStatusReportMutation", () => {
  const stubTx = "stub-tx" as unknown as DatabaseHandle;
  let completions: Array<{ status: number; body: unknown }>;

  beforeEach(() => {
    completions = [];
    vi.mocked(executeIdempotent).mockReset().mockImplementation(async ({ work }) => {
      const context: IdempotencyContext = {
        operationId: "op-1",
        transaction: async (run) => {
          const result = await run(stubTx);
          completions.push({ status: result.status, body: result.body });
          return result;
        },
      };
      const result = await work(context);
      return { ...result, replayed: false };
    });
  });

  it("threads the same transaction handle executeIdempotent opened into work(), and commits the completion through it", async () => {
    const response = await runStatusReportMutation({
      request: mutationRequest(),
      context: { principalKey: "human:1", requestId: "req-1" },
      routeKey: "test",
      body: {},
      work: async (tx) => {
        expect(tx).toBe(stubTx);
        return { status: 200, kind: "StatusReport", data: { id: "rep-1" } };
      },
    });

    expect(response.status).toBe(200);
    expect(completions).toEqual([{
      status: 200,
      body: { apiVersion: "v1", kind: "StatusReport", data: { id: "rep-1" }, meta: { requestId: "req-1" } },
    }]);
  });

  it("records a StatusReportError thrown by work() as the operation's own completed response, mapped to its HTTP status", async () => {
    const response = await runStatusReportMutation({
      request: mutationRequest(),
      context: { principalKey: "human:1", requestId: "req-1" },
      routeKey: "test",
      body: {},
      work: async () => {
        throw new StatusReportError("ALREADY_PUBLISHED", "The status report is already published");
      },
    });

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error.code).toBe("ALREADY_PUBLISHED");
    // Committed, not left running: the mapped 409 is the operation's own
    // durable response, recorded alongside (the absent) mutation, so a retry
    // replays this verbatim instead of rerunning work().
    expect(completions).toMatchObject([{ status: 409 }]);
  });

  it("propagates a non-domain error out of the transaction and never persists a completion", async () => {
    const response = await runStatusReportMutation({
      request: mutationRequest(),
      context: { principalKey: "human:1", requestId: "req-1" },
      routeKey: "test",
      body: {},
      work: async () => {
        throw new Error("boom");
      },
    });

    // Mapped to a generic error response by the outer catch, not a stored
    // 4xx: this is not a domain outcome, so nothing about it is durable, and
    // the (faked) transaction never reaches its commit step.
    expect(response.status).toBe(500);
    expect(completions).toEqual([]);
  });
});
