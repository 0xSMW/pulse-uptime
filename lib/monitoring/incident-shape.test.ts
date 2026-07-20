import { describe, expect, it } from "vitest";

import { durationSeconds, failureLabel, summarizeNotificationRows } from "./incident-shape";

describe("failureLabel", () => {
  it("prefers the HTTP status code over the error code", () => {
    expect(failureLabel("TIMEOUT", 503)).toBe("HTTP 503");
  });

  it("falls back to the error code, then to Unknown failure", () => {
    expect(failureLabel("DNS_ERROR", null)).toBe("DNS_ERROR");
    expect(failureLabel(null, null)).toBe("Unknown failure");
  });
});

describe("durationSeconds", () => {
  it("floors the elapsed seconds and never returns a negative value", () => {
    const opened = new Date("2026-07-18T00:00:00.000Z");
    expect(durationSeconds(opened, new Date("2026-07-18T00:01:30.900Z"))).toBe(90);
    expect(durationSeconds(opened, new Date("2026-07-17T23:59:00.000Z"))).toBe(0);
  });

  it("measures against now when the incident is unresolved", () => {
    const opened = new Date("2026-07-18T00:00:00.000Z");
    expect(durationSeconds(opened, null, new Date("2026-07-18T00:00:10.000Z"))).toBe(10);
  });
});

describe("summarizeNotificationRows", () => {
  it("reports none, sent, retrying, and dead by precedence", () => {
    expect(summarizeNotificationRows([])).toEqual({ state: "none", sentCount: 0 });
    expect(summarizeNotificationRows([{ status: "sent" }, { status: "sent" }])).toEqual({ state: "sent", sentCount: 2 });
    expect(summarizeNotificationRows([{ status: "sent" }, { status: "pending" }])).toEqual({ state: "retrying", sentCount: 1 });
    expect(summarizeNotificationRows([{ status: "sent" }, { status: "dead" }])).toEqual({ state: "dead", sentCount: 1 });
  });
});
