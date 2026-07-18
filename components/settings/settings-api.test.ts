import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest, expiryFromDays, generatedMonitorId, messageForError, SettingsApiError } from "./settings-api";
import { isPublicMonitorUrl, monitorSheetActionLabels, parseRecipients, validateMonitorForm, type MonitorFormValues } from "./monitor-sheet";

const valid: MonitorFormValues = {
  name: "API", url: "https://example.com/health", enabled: true, group: null,
  method: "GET", intervalMinutes: 1, timeoutMs: 8000, expectedStatusMin: 200,
  expectedStatusMax: 399, failureThreshold: 2, recoveryThreshold: 2,
  recipients: [], recipientsText: "ops@example.com",
};

describe("Settings form helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "12345678-1234-1234-1234-123456789abc" });
  });

  it("generates a bounded lowercase slug", () => {
    expect(generatedMonitorId("  Main API / Health  ")).toBe("main-api-health-12345678");
  });

  it("creates explicit UTC expiries", () => {
    expect(expiryFromDays(30, new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-31T00:00:00.000Z");
  });

  it("parses newline and comma separated recipients", () => {
    expect(parseRecipients("a@example.com\nb@example.com, c@example.com")).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
  });

  it("validates cross-field status and recipients", () => {
    expect(validateMonitorForm(valid)).toEqual({});
    expect(validateMonitorForm({ ...valid, expectedStatusMax: 199, recipientsText: "bad" })).toMatchObject({
      expectedStatusMax: expect.any(String), recipientsText: expect.any(String),
    });
  });

  it("rejects private and reserved monitor targets", () => {
    expect(isPublicMonitorUrl("http://127.0.0.1/health")).toBe(false);
    expect(isPublicMonitorUrl("http://192.168.1.20/health")).toBe(false);
    expect(isPublicMonitorUrl("http://[::1]/health")).toBe(false);
    expect(isPublicMonitorUrl("https://example.com/health")).toBe(true);
  });

  it("adds a fresh idempotency key to mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiRequest("/api/v1/tokens/token-id", { method: "DELETE" }, true);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toBe("12345678-1234-1234-1234-123456789abc");
  });

  it("uses the exact configuration conflict copy", () => {
    expect(messageForError(new SettingsApiError("stale", 409, "CONFIG_VERSION_CONFLICT"))).toBe(
      "Configuration changed elsewhere. Reload before saving.",
    );
  });

  it("keeps edit-sheet header actions in test, state, archive order", () => {
    expect(monitorSheetActionLabels(true)).toEqual(["Run Test", "Pause", "Archive"]);
    expect(monitorSheetActionLabels(false)).toEqual(["Run Test", "Resume", "Archive"]);
  });
});
