import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: { impl: "default-db" } }));
vi.mock("./config-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-mutation")>()),
  mutateConfig: vi.fn(async (_principalKey: string, mutator: (config: unknown) => unknown) => mutator(BASE_CONFIG)),
}));

import type { DatabaseHandle } from "@/lib/db/client";
import { db } from "@/lib/db/client";

import { mutateConfig } from "./config-mutation";
import { archiveMonitor, createMonitor, mergeMonitorPatch, MonitorApiError, parseCreateMonitor, parsePatchMonitor, setMonitorEnabled, updateMonitor } from "./monitors";

const EXISTING = parseCreateMonitor({ id: "site-home", name: "Site", url: "https://example.com" });
const BASE_CONFIG = { schemaVersion: 2, configVersion: 1, groups: [], monitors: [EXISTING] };

describe("monitor API request parsing", () => {
  it("applies the documented safe defaults to creates", () => {
    expect(parseCreateMonitor({ id: "site-home", name: "Site", url: "https://example.com" })).toMatchObject({
      id: "site-home", enabled: true, method: "GET", intervalMinutes: 1, timeoutMs: 8_000,
      expectedStatus: { minimum: 200, maximum: 399 }, failureThreshold: 2, recoveryThreshold: 2,
    });
  });

  it("requires a nonempty strict patch and preserves nested fields", () => {
    const groups = [{ id: "production", name: "Production" }];
    const monitor = parseCreateMonitor({ id: "site-home", name: "Site", url: "https://example.com", groupId: "production", expectedStatus: { minimum: 200, maximum: 299 } }, groups);
    expect(() => parsePatchMonitor({})).toThrow();
    expect(() => parsePatchMonitor({ unknown: true })).toThrow();
    expect(mergeMonitorPatch(monitor, parsePatchMonitor({ name: "Renamed" }))).toMatchObject({
      name: "Renamed", groupId: "production", expectedStatus: { minimum: 200, maximum: 299 },
    });
  });

  it("accepts a group ID or legacy group name but never both", () => {
    const groups = [{ id: "production", name: "Production" }];
    expect(parseCreateMonitor({ id: "site-one", name: "One", url: "https://one.example.com", group: "production" }, groups).groupId).toBe("production");
    expect(() => parseCreateMonitor({ id: "site-two", name: "Two", url: "https://two.example.com", group: "Production", groupId: "production" }, groups)).toThrow();
  });
});

describe("handle threading to mutateConfig (finding: the mutation and the idempotency completion must commit in the same transaction, so the route's tx must reach mutateConfig, not the default pool)", () => {
  const routeTx = { impl: "route-tx" } as unknown as DatabaseHandle;

  it("createMonitor forwards the given handle", async () => {
    await createMonitor({ id: "site-two", name: "Two", url: "https://two.example.com" }, "human:1", routeTx);
    expect(mutateConfig).toHaveBeenLastCalledWith("human:1", expect.any(Function), routeTx);
  });

  it("createMonitor defaults to the db handle when none is given", async () => {
    await createMonitor({ id: "site-three", name: "Three", url: "https://three.example.com" }, "human:1");
    expect(mutateConfig).toHaveBeenLastCalledWith("human:1", expect.any(Function), db);
  });

  it("updateMonitor forwards the given handle", async () => {
    await updateMonitor("site-home", { name: "Renamed" }, "human:1", routeTx);
    expect(mutateConfig).toHaveBeenLastCalledWith("human:1", expect.any(Function), routeTx);
  });

  it("setMonitorEnabled forwards the given handle", async () => {
    await setMonitorEnabled("site-home", false, "human:1", routeTx);
    expect(mutateConfig).toHaveBeenLastCalledWith("human:1", expect.any(Function), routeTx);
  });

  it("archiveMonitor forwards the given handle to mutateConfig and to the archived-registry fallback read on MONITOR_NOT_FOUND", async () => {
    vi.mocked(mutateConfig).mockRejectedValueOnce(new MonitorApiError("MONITOR_NOT_FOUND", "Monitor was not found"));
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(async () => [{ id: "site-missing" }]);
    const fallbackHandle = { select: vi.fn(() => chain) } as unknown as DatabaseHandle;

    const result = await archiveMonitor("site-missing", "human:1", fallbackHandle);

    expect(mutateConfig).toHaveBeenLastCalledWith("human:1", expect.any(Function), fallbackHandle);
    expect(fallbackHandle.select).toHaveBeenCalled();
    expect(result).toEqual({ id: "site-missing", archived: true });
  });
});
