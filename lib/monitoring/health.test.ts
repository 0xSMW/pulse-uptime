import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { dbMock } = vi.hoisted(() => ({ dbMock: { select: vi.fn() } }));
vi.mock("@/lib/db/client", () => ({ db: dbMock }));

import { getHealthWarnings } from "./health";

const now = new Date("2026-01-01T00:00:00.000Z");
const minutesAgo = (value: number) => new Date(now.getTime() - value * 60_000);

/** A chainable stand-in for a drizzle `db.select(...).from(...)....limit(...)` call. */
function selectChain(outcome: unknown[]) {
  const promise = Promise.resolve(outcome);
  const node = {
    from: () => node,
    where: () => node,
    orderBy: () => node,
    limit: () => promise,
  };
  return node;
}

// getHealthWarnings issues the same seven selects in order: monitor-check run,
// maintenance run, check-dependencies run, installed dependency probe,
// config snapshot, dead outbox, recent monitor-check statuses. Each override
// maps to that position.
interface Rows {
  monitorCheck?: unknown[];
  maintenance?: unknown[];
  dependencyCheck?: unknown[];
  installedDependency?: unknown[];
  configSnapshot?: unknown[];
  deadOutbox?: unknown[];
  recentChecks?: unknown[];
}

function stubSelects(rows: Rows = {}) {
  const fresh = [{ completedAt: minutesAgo(1) }];
  const completedRuns = [{ status: "completed" }, { status: "completed" }, { status: "completed" }];
  dbMock.select
    .mockReturnValueOnce(selectChain(rows.monitorCheck ?? fresh))
    .mockReturnValueOnce(selectChain(rows.maintenance ?? [{ completedAt: minutesAgo(60) }]))
    .mockReturnValueOnce(selectChain(rows.dependencyCheck ?? fresh))
    .mockReturnValueOnce(selectChain(rows.installedDependency ?? [{ id: "dep" }]))
    .mockReturnValueOnce(selectChain(rows.configSnapshot ?? [{ status: "accepted" }]))
    .mockReturnValueOnce(selectChain(rows.deadOutbox ?? []))
    .mockReturnValueOnce(selectChain(rows.recentChecks ?? completedRuns));
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReset();
});

describe("getHealthWarnings", () => {
  it("warns when the dependency poller has not completed within three minutes", async () => {
    stubSelects({ dependencyCheck: [{ completedAt: minutesAgo(4) }] });
    const warnings = await getHealthWarnings(now);
    expect(warnings).toContainEqual({
      code: "DEPENDENCY_POLLER_STALE",
      message: "Dependency updates are delayed",
      action: "Check Vercel Cron",
    });
  });

  it("warns when the dependency poller has never completed and a dependency is installed", async () => {
    stubSelects({ dependencyCheck: [] });
    const codes = (await getHealthWarnings(now)).map((warning) => warning.code);
    expect(codes).toContain("DEPENDENCY_POLLER_STALE");
  });

  it("does not warn when the dependency poller completed within three minutes", async () => {
    stubSelects({ dependencyCheck: [{ completedAt: minutesAgo(2) }] });
    const codes = (await getHealthWarnings(now)).map((warning) => warning.code);
    expect(codes).not.toContain("DEPENDENCY_POLLER_STALE");
  });

  it("does not warn about a stale poller on a fresh install with no dependencies installed", async () => {
    stubSelects({ dependencyCheck: [], installedDependency: [] });
    const codes = (await getHealthWarnings(now)).map((warning) => warning.code);
    expect(codes).not.toContain("DEPENDENCY_POLLER_STALE");
  });

  it("keeps surfacing the monitor cron warning independent of the dependency poller", async () => {
    stubSelects({ monitorCheck: [{ completedAt: minutesAgo(10) }], dependencyCheck: [{ completedAt: minutesAgo(1) }] });
    const codes = (await getHealthWarnings(now)).map((warning) => warning.code);
    expect(codes).toContain("MONITORING_STALE");
    expect(codes).not.toContain("DEPENDENCY_POLLER_STALE");
  });

  it("warns when the last three monitor-check runs all failed", async () => {
    stubSelects({ recentChecks: [{ status: "failed" }, { status: "failed" }, { status: "failed" }] });
    const warnings = await getHealthWarnings(now);
    expect(warnings).toContainEqual({
      code: "MONITORING_FAILING",
      message: "Scheduled checks are failing",
      action: "Check Cron Errors",
    });
  });

  it("does not warn about failing checks when a recent run completed", async () => {
    stubSelects({ recentChecks: [{ status: "completed" }, { status: "failed" }, { status: "failed" }] });
    const codes = (await getHealthWarnings(now)).map((warning) => warning.code);
    expect(codes).not.toContain("MONITORING_FAILING");
  });
});
