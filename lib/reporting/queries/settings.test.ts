import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { dbMock, findAcceptedSnapshotMock } = vi.hoisted(() => ({
  dbMock: { select: vi.fn() },
  findAcceptedSnapshotMock: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ db: dbMock }));
vi.mock("@/lib/config/accepted-config", () => ({ findAcceptedSnapshot: findAcceptedSnapshotMock }));

import { ADMINISTRATOR_SCOPES } from "@/lib/api/scopes";

import { getAccessSettings, getNotificationSettings, getSecuritySettings } from "./settings";

/** A chainable stand-in for a drizzle `db.select(...).from(...)....limit(...)` call. */
function selectChain(rows: unknown[]) {
  const node = {
    from: () => node,
    innerJoin: () => node,
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
  findAcceptedSnapshotMock.mockReset();
});

describe("getAcceptedConfig graceful degradation (finding: a bad accepted snapshot must degrade to defaults, not crash the settings render)", () => {
  it("returns notification defaults when the accepted snapshot is invalid or hash-mismatched", async () => {
    findAcceptedSnapshotMock.mockRejectedValueOnce(new Error("Accepted monitoring configuration hash is invalid"));
    const result = await getNotificationSettings();
    expect(result.defaultRecipients).toEqual([]);
  });

  it("returns notification defaults when there is no accepted snapshot", async () => {
    findAcceptedSnapshotMock.mockResolvedValueOnce(null);
    const result = await getNotificationSettings();
    expect(result.defaultRecipients).toEqual([]);
  });
});

describe("getSecuritySettings (finding: the 100-row cap ranked by recency could exclude the current session entirely, showing no 'current session' row at all)", () => {
  it("still shows the current session when it's older than the top 100 by recency", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const cappedRows = Array.from({ length: 100 }, (_, i) =>
      sessionRow({ id: `sess-${i}`, createdAt: new Date(now.getTime() - i * 1_000) }));
    const currentRow = sessionRow({ id: "sess-current", createdAt: new Date(now.getTime() - 999_999_000) });

    // First query (top 100 by recency) doesn't include the old current
    // session. The fallback point lookup by id finds it.
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

function cliSessionRow(overrides: Partial<{
  id: string;
  prefix: string;
  scopes: string[];
  scopeProfile: string | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
  displayName: string;
  platform: string;
  architecture: string;
}> = {}) {
  return {
    id: "cli-1",
    prefix: "plc_abc1",
    scopes: ["monitors:read"],
    scopeProfile: null,
    expiresAt: new Date("2026-08-18T12:00:00.000Z"),
    lastUsedAt: null,
    displayName: "Stephen's laptop",
    platform: "darwin",
    architecture: "arm64",
    ...overrides,
  };
}

describe("getAccessSettings (finding: after the scope_profile backfill, auth grants the live profile scopes while the access page still displayed the stale literal scopes column)", () => {
  it("reports the resolved profile scopes for a CLI session whose literal scopes column is stale", async () => {
    const session = cliSessionRow({
      scopeProfile: "administrator",
      // Pre-migration snapshot that no longer reflects what auth grants.
      scopes: ["monitors:read", "incidents:read"],
    });
    dbMock.select
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([session]));

    const result = await getAccessSettings();
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].scopes).toEqual([...ADMINISTRATOR_SCOPES]);
    expect(result.tokens[0].scopes).toContain("reports:read");
  });

  it("falls back to the literal scopes column when scope_profile is null", async () => {
    const session = cliSessionRow({ scopeProfile: null, scopes: ["monitors:read", "incidents:read"] });
    dbMock.select
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([session]));

    const result = await getAccessSettings();
    expect(result.tokens[0].scopes).toEqual(["monitors:read", "incidents:read"]);
  });

  it("falls back to the literal scopes column when the stored profile name is unknown, matching auth's resolution", async () => {
    const session = cliSessionRow({ scopeProfile: "not-a-real-profile", scopes: ["status:read"] });
    dbMock.select
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([session]));

    const result = await getAccessSettings();
    expect(result.tokens[0].scopes).toEqual(["status:read"]);
  });
});
