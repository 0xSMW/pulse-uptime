import { afterEach, describe, expect, it } from "vitest";

import { CRON_RESPONSE_HEADERS, isAuthorizedCronRequest } from "@/lib/scheduler/authentication";

describe("cron route security", () => {
  afterEach(() => { delete process.env.CRON_SECRET; });

  it("requires an exact bearer secret", () => {
    const secret = "a".repeat(32);
    expect(isAuthorizedCronRequest(new Request("https://pulse.test/api/cron/check-monitors", {
      headers: { authorization: `Bearer ${secret}` },
    }), secret)).toBe(true);
    expect(isAuthorizedCronRequest(new Request("https://pulse.test/api/cron/check-monitors", {
      headers: { authorization: "Bearer wrong" },
    }), secret)).toBe(false);
  });

  it("sets explicit no-store response headers", () => {
    expect(CRON_RESPONSE_HEADERS["cache-control"]).toContain("no-store");
  });
});
