import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./migrate-deploy.mjs";

const SECRET = "super-secret-password";
const NEON_DIRECT =
  `postgresql://pulse_owner:${encodeURIComponent(SECRET)}@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const NEON_POOLER =
  `postgresql://pulse_owner:${encodeURIComponent(SECRET)}@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`;

function captureLogs() {
  const info: string[] = [];
  const error: string[] = [];
  const infoSpy = vi.spyOn(console, "info").mockImplementation((msg?: unknown) => {
    info.push(String(msg));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    error.push(String(msg));
  });
  return {
    info,
    error,
    restore() {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("migrate-deploy main", () => {
  it("skips when not production and never connects", async () => {
    const connect = vi.fn();
    const logs = captureLogs();

    await main({
      env: { VERCEL_ENV: "preview", DATABASE_URL_UNPOOLED: NEON_DIRECT },
      connect: connect as never,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(logs.info.some((line) => line.includes("migrate.skipped"))).toBe(true);
    logs.restore();
  });

  it("rejects a pooler URL and never calls postgres()", async () => {
    const connect = vi.fn();
    const exitWithError = vi.fn();
    const logs = captureLogs();

    await main({
      env: { VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: NEON_POOLER },
      connect: connect as never,
      exitWithError,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(exitWithError).toHaveBeenCalledTimes(1);
    expect(exitWithError.mock.calls[0]?.[0]).toMatch(/pooler_hostname/);
    expect(logs.info.some((line) => line.includes("migrate.url.rejected"))).toBe(true);

    const all = [...logs.info, ...logs.error, String(exitWithError.mock.calls[0]?.[0])].join(
      "\n",
    );
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("pulse_owner");
    expect(all).not.toContain(NEON_POOLER);
    logs.restore();
  });

  it("rejects explicit pgbouncer options and never calls postgres()", async () => {
    const connect = vi.fn();
    const exitWithError = vi.fn();
    const logs = captureLogs();
    const url =
      `postgresql://pulse_owner:${encodeURIComponent(SECRET)}@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?pgbouncer=true`;

    await main({
      env: { VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: url },
      connect: connect as never,
      exitWithError,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(exitWithError).toHaveBeenCalledTimes(1);
    expect(exitWithError.mock.calls[0]?.[0]).toMatch(/pooler_options/);
    logs.restore();
  });

  it("rejects invalid scheme and never calls postgres()", async () => {
    const connect = vi.fn();
    const exitWithError = vi.fn();
    const logs = captureLogs();

    await main({
      env: {
        VERCEL_ENV: "production",
        DATABASE_URL_UNPOOLED: `https://pulse_owner:${SECRET}@db.example.com/neondb`,
      },
      connect: connect as never,
      exitWithError,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(exitWithError.mock.calls[0]?.[0]).toMatch(/invalid_scheme/);
    logs.restore();
  });

  it("rejects missing database name and never calls postgres()", async () => {
    const connect = vi.fn();
    const exitWithError = vi.fn();
    const logs = captureLogs();

    await main({
      env: {
        VERCEL_ENV: "production",
        DATABASE_URL_UNPOOLED: `postgresql://pulse_owner:${SECRET}@ep-cool.us-east-2.aws.neon.tech`,
      },
      connect: connect as never,
      exitWithError,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(exitWithError.mock.calls[0]?.[0]).toMatch(/missing_database/);
    logs.restore();
  });

  it("logs sanitized host and database on success path before connecting", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    // Tagged-template client mock used for advisory lock + unlock.
    const sql = Object.assign(
      vi.fn().mockResolvedValue([{ acquired: true }]),
      { end },
    );
    const connect = vi.fn().mockReturnValue(sql);
    const db = { mock: true };
    const createDb = vi.fn().mockReturnValue(db);
    const runMigrate = vi.fn().mockResolvedValue(undefined);
    const logs = captureLogs();

    await main({
      env: { VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: NEON_DIRECT },
      connect: connect as never,
      createDb: createDb as never,
      runMigrate: runMigrate as never,
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(NEON_DIRECT, { max: 1, onnotice: expect.any(Function) });
    expect(createDb).toHaveBeenCalledWith(sql);
    expect(runMigrate).toHaveBeenCalledWith(db, { migrationsFolder: "drizzle" });

    const validatedLine = logs.info.find((line) => line.includes("migrate.url.validated"));
    expect(validatedLine).toBeDefined();
    expect(validatedLine).toContain("ep-cool-name-123456.us-east-2.aws.neon.tech");
    expect(validatedLine).toContain("neondb");
    expect(validatedLine).not.toContain(SECRET);
    expect(validatedLine).not.toContain("pulse_owner");

    const joined = logs.info.join("\n");
    expect(joined).not.toContain(SECRET);
    expect(joined).toContain("migrate.started");
    expect(joined).toContain("migrate.completed");
    expect(end).toHaveBeenCalled();
    logs.restore();
  });

  it("fails when DATABASE_URL_UNPOOLED is unset without connecting", async () => {
    const connect = vi.fn();
    const exitWithError = vi.fn();

    await main({
      env: { VERCEL_ENV: "production" },
      connect: connect as never,
      exitWithError,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(exitWithError.mock.calls[0]?.[0]).toMatch(/DATABASE_URL_UNPOOLED is not set/);
  });
});
