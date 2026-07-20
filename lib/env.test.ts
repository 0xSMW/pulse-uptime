import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./env";
import { DEFAULT_STATUS_PAGE_NAME } from "./status-page/schema";

const validEnv = {
  DATABASE_URL: "postgresql://pulse:secret@example.com/pulse",
  EDGE_CONFIG: "https://edge-config.vercel.com/ecfg_test?token=test",
  EDGE_CONFIG_ID: "ecfg_test",
  VERCEL_API_TOKEN: "test-token",
  CRON_SECRET: "c".repeat(32),
  RESEND_API_KEY: "re_test",
  RESEND_FROM_EMAIL: "pulse@example.com",
  API_TOKEN_HASH_KEY: "a".repeat(32),
  DEVICE_AUTH_SECRET: "d".repeat(32),
  NEXT_PUBLIC_APP_URL: "https://pulse.example.com",
  NEXT_PUBLIC_STATUS_PAGE_NAME: "Pulse Status",
};

describe("server environment", () => {
  it("accepts the canonical production variables", () => {
    expect(parseServerEnv(validEnv).EDGE_CONFIG_ID).toBe("ecfg_test");
  });

  it("rejects short security secrets", () => {
    expect(() => parseServerEnv({ ...validEnv, CRON_SECRET: "short" })).toThrow();
  });

  it("defaults the status page name to the shared constant", () => {
    const { NEXT_PUBLIC_STATUS_PAGE_NAME: _omitted, ...withoutName } = validEnv;
    void _omitted;
    expect(parseServerEnv(withoutName).NEXT_PUBLIC_STATUS_PAGE_NAME).toBe(DEFAULT_STATUS_PAGE_NAME);
    expect(DEFAULT_STATUS_PAGE_NAME).toBe("Pulse Status");
  });
});
