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

import { databaseStatusReportsStore } from "@/lib/api/status-reports";

import { revalidateStatusReportPaths } from "./status-report-http";

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
