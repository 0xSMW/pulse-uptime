import { describe, expect, it, vi } from "vitest";

import { ACQUIRE_LEASE_SQL, createSqlCronRunStore, createSqlLeaseStore } from "./sql";

describe("scheduler SQL", () => {
  it("creates and replaces leases against the Postgres clock", () => {
    expect(ACQUIRE_LEASE_SQL).toContain("clock_timestamp() + ($3 * interval '1 millisecond')");
    expect(ACQUIRE_LEASE_SQL).toContain("job_leases.lease_until <= clock_timestamp()");
  });

  it("releases only a matching owner", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await createSqlLeaseStore({ query }).release("monitor-check", "owner");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("owner_id = $2"), ["monitor-check", "owner"]);
  });

  it("records release_id when starting a cron run", async () => {
    const query = vi.fn().mockResolvedValue([{ id: "run-1" }]);
    const started = await createSqlCronRunStore({ query }).start({
      id: "run-1",
      jobName: "monitor-check",
      scheduledMinute: new Date("2026-07-20T12:00:00.000Z"),
      startedAt: new Date("2026-07-20T12:00:01.000Z"),
      releaseId: "dpl_abc",
    });
    expect(started).toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("release_id"),
      expect.arrayContaining(["dpl_abc"]),
    );
  });
});
