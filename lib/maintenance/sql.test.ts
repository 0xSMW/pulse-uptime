import { describe, expect, it, vi } from "vitest";

import { createSqlMaintenanceStore, ROLLUP_DAY_SQL } from "./sql";

describe("maintenance SQL store", () => {
  it("uses an upsert for deterministic rollup recalculation", () => {
    expect(ROLLUP_DAY_SQL).toContain("on conflict (monitor_id, day) do update");
    expect(ROLLUP_DAY_SQL).toContain("percentile_cont(0.95)");
  });

  it("passes the exact retention batch limit to raw-check deletion", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const cutoff = new Date("2026-06-18T00:00:00Z");
    await createSqlMaintenanceStore({ query }).deleteRawChecks(cutoff, 10_000);
    expect(query.mock.calls[0]?.[0]).toContain("limit $2");
    expect(query.mock.calls[0]?.[1]).toEqual([cutoff, 10_000]);
  });

  it("uses shared stale-claim reconciliation with its ambiguity cutoff", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await createSqlMaintenanceStore({ query }).reconcileStaleOutbox(new Date("2026-07-18T04:00:00Z"));
    expect(query.mock.calls[0]?.[1]).toHaveLength(3);
    expect(query.mock.calls[0]?.[0]).toContain("AMBIGUOUS_PROVIDER_RESULT");
  });
});
