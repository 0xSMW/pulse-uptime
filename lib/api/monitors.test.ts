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
    const monitor = parseCreateMonitor({ id: "site-home", name: "Site", url: "https://example.com", expectedStatus: { minimum: 200, maximum: 299 } });
    expect(() => parsePatchMonitor({})).toThrow();
    expect(() => parsePatchMonitor({ unknown: true })).toThrow();
    expect(mergeMonitorPatch(monitor, parsePatchMonitor({ name: "Renamed" }))).toMatchObject({
      name: "Renamed", expectedStatus: { minimum: 200, maximum: 299 },
    });
  });
});
