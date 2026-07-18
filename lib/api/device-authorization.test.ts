import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

process.env.DEVICE_AUTH_SECRET = "device-secret-with-at-least-32-characters";
process.env.API_TOKEN_HASH_KEY = "api-token-key-with-at-least-32-characters";

const { db } = vi.hoisted(() => {
  function chain(result: unknown[]) {
    const c: Record<string, unknown> = {};
    for (const method of ["from", "where", "limit", "for"]) {
      c[method] = vi.fn(() => c);
    }
    c.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return c;
  }

  const selectResults: unknown[][] = [];
  const selectColumnsCalls: unknown[] = [];
  const updateResults: unknown[][] = [];
  const updateReturningColumnsCalls: unknown[] = [];
  const updateSetValues: unknown[] = [];
  const insertValues: unknown[] = [];

  const dbImpl = {
    select: vi.fn((columns: unknown) => {
      selectColumnsCalls.push(columns);
      return chain(selectResults.shift() ?? []);
    }),
    update: vi.fn(() => {
      const c: Record<string, unknown> = {};
      c.set = vi.fn((value: unknown) => { updateSetValues.push(value); return c; });
      c.where = vi.fn(() => c);
      c.returning = vi.fn((columns: unknown) => {
        updateReturningColumnsCalls.push(columns);
        const result = updateResults.shift() ?? [];
        c.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
        return c;
      });
      c.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve, reject);
      return c;
    }),
    insert: vi.fn(() => {
      const c: Record<string, unknown> = {};
      c.values = vi.fn((value: unknown) => { insertValues.push(value); return c; });
      c.onConflictDoUpdate = vi.fn(() => c);
      c.onConflictDoNothing = vi.fn(() => c);
      c.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve, reject);
      return c;
    }),
    transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(dbImpl)),
  };

  return {
    db: {
      impl: dbImpl,
      selectResults,
      selectColumnsCalls,
      updateResults,
      updateReturningColumnsCalls,
      updateSetValues,
      insertValues,
    },
  };
});

vi.mock("@/lib/db/client", () => ({ db: db.impl }));

import { approveDeviceAuthorization, DeviceAuthorizationError, pollDeviceAuthorization } from "./device-authorization";
import { ADMINISTRATOR_SCOPES } from "./scopes";

function resetDb() {
  db.selectResults.length = 0;
  db.selectColumnsCalls.length = 0;
  db.updateResults.length = 0;
  db.updateReturningColumnsCalls.length = 0;
  db.updateSetValues.length = 0;
  db.insertValues.length = 0;
  vi.clearAllMocks();
}

beforeEach(resetDb);

describe("approveDeviceAuthorization", () => {
  const now = new Date("2026-07-18T12:00:00.000Z");
  const human = { id: "human-1", email: "owner@example.com" };

  it("returns exactly the fields the caller consumes and passes them through to the installation upsert", async () => {
    db.updateResults.push([{
      id: "auth-1",
      userCode: "ABCD-1234",
      clientName: "pulsectl",
      installationKey: "install-key-1",
      installationName: "laptop",
      platform: "darwin",
      architecture: "arm64",
      clientVersion: "1.2.3",
      requestIp: "203.0.113.5",
      expiresAt: new Date("2026-07-18T12:10:00.000Z"),
    }]);

    const result = await approveDeviceAuthorization("abcd-1234", human, now);

    expect(result).toEqual({
      id: "auth-1",
      userCode: "ABCD-1234",
      clientName: "pulsectl",
      installationName: "laptop",
      platform: "darwin",
      architecture: "arm64",
      clientVersion: "1.2.3",
      requestIp: "203.0.113.5",
      expiresAt: new Date("2026-07-18T12:10:00.000Z"),
      scopes: ADMINISTRATOR_SCOPES,
    });

    expect(Object.keys(db.updateReturningColumnsCalls[0] as object).sort()).toEqual([
      "architecture",
      "clientName",
      "clientVersion",
      "expiresAt",
      "id",
      "installationKey",
      "installationName",
      "platform",
      "requestIp",
      "userCode",
    ]);

    expect(db.insertValues[0]).toMatchObject({
      installationKey: "install-key-1",
      userEmail: human.email,
      displayName: "laptop",
      platform: "darwin",
      architecture: "arm64",
      clientVersion: "1.2.3",
    });
  });

  it("throws expired_token and never touches the installation table when no pending row matches", async () => {
    db.updateResults.push([]);

    await expect(approveDeviceAuthorization("abcd-1234", human, now)).rejects.toMatchObject({
      code: "expired_token",
    });
    expect(db.impl.insert).not.toHaveBeenCalled();
  });
});

describe("pollDeviceAuthorization", () => {
  const now = new Date("2026-07-18T12:00:00.000Z");

  it("locks the narrowed authorization row, narrow-selects the installation, and mints a session on success", async () => {
    db.selectResults.push([{
      id: "auth-1",
      state: "approved",
      expiresAt: new Date("2026-07-18T12:10:00.000Z"),
      installationKey: "install-key-1",
      lastPolledAt: null,
      pollCount: 0,
      pollingIntervalSeconds: 5,
    }]);
    db.selectResults.push([{ id: "installation-1", userEmail: "user@example.com" }]);
    db.updateResults.push([{ id: "auth-1" }]);

    const result = await pollDeviceAuthorization("raw-device-code", now);

    expect(result).toMatchObject({
      tokenType: "Bearer",
      scopes: ADMINISTRATOR_SCOPES,
    });
    expect(typeof result.token).toBe("string");

    expect(Object.keys(db.selectColumnsCalls[0] as object).sort()).toEqual([
      "expiresAt",
      "id",
      "installationKey",
      "lastPolledAt",
      "pollCount",
      "pollingIntervalSeconds",
      "state",
    ]);
    expect(Object.keys(db.selectColumnsCalls[1] as object).sort()).toEqual(["id", "userEmail"]);

    expect(db.insertValues[0]).toMatchObject({
      installationId: "installation-1",
      userEmail: "user@example.com",
      scopes: [...ADMINISTRATOR_SCOPES],
    });
  });

  it("still enforces the polling backoff using only the narrowed columns, without reaching the installation lookup", async () => {
    db.selectResults.push([{
      id: "auth-1",
      state: "pending",
      expiresAt: new Date("2026-07-18T12:10:00.000Z"),
      installationKey: "install-key-1",
      lastPolledAt: new Date("2026-07-18T11:59:58.000Z"),
      pollCount: 2,
      pollingIntervalSeconds: 5,
    }]);

    await expect(pollDeviceAuthorization("raw-device-code", now)).rejects.toMatchObject({
      code: "slow_down",
    });

    expect(db.selectColumnsCalls).toHaveLength(1);
    expect(db.updateSetValues[0]).toMatchObject({ pollCount: 3, pollingIntervalSeconds: 10 });
  });

  it("propagates expired_token when the device code row is gone, without any installation lookup", async () => {
    db.selectResults.push([]);

    await expect(pollDeviceAuthorization("raw-device-code", now)).rejects.toBeInstanceOf(DeviceAuthorizationError);
    expect(db.selectColumnsCalls).toHaveLength(1);
  });
});
