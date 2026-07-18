import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { dbMock } = vi.hoisted(() => ({ dbMock: { select: vi.fn() } }));
vi.mock("@/lib/db/client", () => ({ db: dbMock }));

import { getSecuritySettings } from "./settings";

/** A chainable stand-in for a drizzle `db.select(...).from(...)....limit(...)` call. */
function selectChain(rows: unknown[]) {
  const node = {
    from: () => node,
    where: () => node,
    orderBy: () => node,
    limit: () => Promise.resolve(rows),
  };
  return node;
}

function sessionRow(overrides: Partial<{
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
}> = {}) {
  return {
    id: "sess-1",
    userAgent: null,
    ipAddress: "127.0.0.1",
    createdAt: new Date("2026-07-18T12:00:00.000Z"),
    lastSeenAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.select.mockReset();
});

describe("getSecuritySettings (finding: the 100-row cap ranked by recency could exclude the current session entirely, showing no 'current session' row at all)", () => {
  it("still shows the current session when it's older than the top 100 by recency", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const cappedRows = Array.from({ length: 100 }, (_, i) =>
      sessionRow({ id: `sess-${i}`, createdAt: new Date(now.getTime() - i * 1_000) }));
    const currentRow = sessionRow({ id: "sess-current", createdAt: new Date(now.getTime() - 999_999_000) });

    // First query (top 100 by recency) doesn't include the old current
    // session; the fallback point lookup by id finds it.
    dbMock.select
      .mockReturnValueOnce(selectChain(cappedRows))
      .mockReturnValueOnce(selectChain([currentRow]));

    const result = await getSecuritySettings("user-1", "sess-current", now);
    expect(result.sessions).toHaveLength(101);
    expect(result.sessions[0]).toMatchObject({ id: "sess-current", current: true });
    expect(result.sessions.filter((session) => session.current)).toHaveLength(1);
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });

  it("does not issue a second query when the current session is already inside the capped batch", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const rows = [
      sessionRow({ id: "sess-current", createdAt: now }),
      sessionRow({ id: "sess-older", createdAt: new Date(now.getTime() - 60_000) }),
    ];
    dbMock.select.mockReturnValueOnce(selectChain(rows));

    const result = await getSecuritySettings("user-1", "sess-current", now);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(result.sessions[0]).toMatchObject({ id: "sess-current", current: true });
  });

  it("does not force-include a session id that isn't a valid, active session for this user (e.g. already revoked/expired) — the fallback lookup is bounded by the same WHERE clause", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const rows = [sessionRow({ id: "sess-1", createdAt: now })];
    dbMock.select
      .mockReturnValueOnce(selectChain(rows))
      .mockReturnValueOnce(selectChain([])); // the point lookup finds nothing

    const result = await getSecuritySettings("user-1", "sess-revoked", now);
    expect(result.sessions.some((session) => session.current)).toBe(false);
    expect(result.sessions).toHaveLength(1);
  });

  it("keeps the rest newest-signed-in first, with the current session pulled to the front", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    // Rows arrive already newest-first (as the real ORDER BY would produce),
    // with the current session in the middle rather than first.
    const rows = [
      sessionRow({ id: "sess-newest", createdAt: now }),
      sessionRow({ id: "sess-current", createdAt: new Date(now.getTime() - 120_000) }),
      sessionRow({ id: "sess-oldest", createdAt: new Date(now.getTime() - 300_000) }),
    ];
    dbMock.select.mockReturnValueOnce(selectChain(rows));

    const result = await getSecuritySettings("user-1", "sess-current", now);
    expect(result.sessions.map((session) => session.id)).toEqual(["sess-current", "sess-newest", "sess-oldest"]);
  });
});
