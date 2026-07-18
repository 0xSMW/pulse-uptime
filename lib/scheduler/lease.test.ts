import { describe, expect, it, vi } from "vitest";

import { LEASE_DURATION_MS, withLease, type LeaseStore } from "./lease";

describe("withLease", () => {
  it("requests a 90-second database-timed lease and releases the matching owner", async () => {
    const acquire = vi.fn().mockResolvedValue(true);
    const release = vi.fn().mockResolvedValue(undefined);
    const store: LeaseStore = { acquire, release };
    const now = new Date("2026-07-18T04:00:00Z");

    const result = await withLease(store, "monitor-check", "owner", now, async () => 42);

    expect(result).toEqual({ acquired: true, value: 42 });
    expect(acquire).toHaveBeenCalledWith(
      "monitor-check",
      "owner",
      LEASE_DURATION_MS,
    );
    expect(release).toHaveBeenCalledWith("monitor-check", "owner");
  });

  it("does not run work when another owner holds the lease", async () => {
    const work = vi.fn();
    const result = await withLease({
      acquire: vi.fn().mockResolvedValue(false),
      release: vi.fn(),
    }, "maintenance", "owner", new Date(), work);
    expect(result).toEqual({ acquired: false });
    expect(work).not.toHaveBeenCalled();
  });
});
