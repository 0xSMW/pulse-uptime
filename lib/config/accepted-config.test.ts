import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: {} }));

import { DEFAULT_MONITOR_SETTINGS, hashMonitoringConfig, type MonitoringConfig } from "@/lib/config";

import { findAcceptedSnapshot, requireAcceptedSnapshot } from "./accepted-config";

const CONFIG: MonitoringConfig = { schemaVersion: 2, configVersion: 1, settings: { ...DEFAULT_MONITOR_SETTINGS }, groups: [], monitors: [] };
const HASH = hashMonitoringConfig(CONFIG);

/** A fake executor whose select chain resolves to `rows`, capturing the orderBy clauses. */
function fakeExecutor(rows: unknown[]) {
  const captured: { orderBy: unknown[] } = { orderBy: [] };
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = (...clauses: unknown[]) => { captured.orderBy = clauses; return chain; };
  chain.limit = () => Promise.resolve(rows);
  return { executor: { select: () => chain } as never, captured };
}

describe("readAcceptedSnapshot", () => {
  it("returns null when no accepted row exists (find), and throws (require)", async () => {
    const { executor } = fakeExecutor([]);
    await expect(findAcceptedSnapshot(executor)).resolves.toBeNull();
    await expect(requireAcceptedSnapshot(executor)).rejects.toThrow();
  });

  it("returns the config, hash, and acceptedAt for a valid, hash-matching row", async () => {
    const acceptedAt = new Date("2026-07-18T00:00:00.000Z");
    const { executor } = fakeExecutor([{ configJson: CONFIG, configHash: HASH, acceptedAt }]);
    await expect(findAcceptedSnapshot(executor)).resolves.toEqual({ config: CONFIG, hash: HASH, acceptedAt });
  });

  it("orders by acceptedAt then seenAt so ties resolve deterministically", async () => {
    const { executor, captured } = fakeExecutor([{ configJson: CONFIG, configHash: HASH, acceptedAt: null }]);
    await findAcceptedSnapshot(executor);
    expect(captured.orderBy).toHaveLength(2);
  });

  it("throws when the persisted hash no longer matches the stored config", async () => {
    const { executor } = fakeExecutor([{ configJson: CONFIG, configHash: "sha256:stale", acceptedAt: null }]);
    await expect(findAcceptedSnapshot(executor)).rejects.toThrow();
  });

  it("throws when the stored config is structurally invalid", async () => {
    const { executor } = fakeExecutor([{ configJson: { nope: true }, configHash: "sha256:whatever", acceptedAt: null }]);
    await expect(findAcceptedSnapshot(executor)).rejects.toThrow();
  });
});
