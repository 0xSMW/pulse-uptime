import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

process.env.API_TOKEN_HASH_KEY = "api-token-key-with-at-least-32-characters";

import { sourceIpKey } from "./rate-limit";

function keyFor(headers: Record<string, string>): string {
  return sourceIpKey(new Request("https://example.test/", { headers }));
}

describe("sourceIpKey", () => {
  it("honors x-real-ip so keys agree with stored session IPs", () => {
    const realIp = keyFor({ "x-real-ip": "198.51.100.9", "x-forwarded-for": "203.0.113.7" });
    const forwarded = keyFor({ "x-forwarded-for": "198.51.100.9" });
    expect(realIp).toBe(forwarded);
  });

  it("falls back to the first forwarded hop when x-real-ip is absent", () => {
    const first = keyFor({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    const direct = keyFor({ "x-forwarded-for": "203.0.113.7" });
    expect(first).toBe(direct);
  });

  it("keys all header-less requests to the shared unknown bucket", () => {
    expect(keyFor({})).toBe(keyFor({}));
    expect(keyFor({}).startsWith("ip:")).toBe(true);
  });
});
