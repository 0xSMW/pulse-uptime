import { describe, expect, it, vi } from "vitest";

import { ACQUIRE_LEASE_SQL, createSqlLeaseStore } from "./sql";

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
});
