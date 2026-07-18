import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mergeMonitorPatch, parseCreateMonitor, parsePatchMonitor } from "./monitors";

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
