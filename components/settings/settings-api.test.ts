import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  hasAdvancedMonitorFormErrors,
  isPublicMonitorUrl,
  type MonitorFormValues,
  monitorSheetActionLabels,
  parseRecipients,
  validateMonitorForm,
} from "./monitor-sheet"
import {
  apiRequest,
  expiryFromDays,
  generatedGroupId,
  generatedMonitorId,
  groupDeleteBlockedCount,
  messageForError,
  SettingsApiError,
  sortSettingsGroups,
} from "./settings-api"

const valid: MonitorFormValues = {
  name: "API",
  url: "https://example.com/health",
  enabled: true,
  groupId: null,
  method: "GET",
  intervalMinutes: 1,
  timeoutMs: 8000,
  expectedStatusMin: 200,
  expectedStatusMax: 399,
  failureThreshold: 2,
  recoveryThreshold: 2,
  recipientsText: "ops@example.com",
}

describe("Settings form helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    })
  })

  it("generates a bounded lowercase slug", () => {
    expect(generatedMonitorId("  Main API / Health  ")).toBe(
      "main-api-health-12345678"
    )
    expect(generatedGroupId(" Core Services ")).toBe("core-services-12345678")
    expect(generatedGroupId(`${"a".repeat(54)}-group`)).toMatch(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    )
  })

  it("sorts groups alphabetically without mutating input", () => {
    const groups = [
      { id: "zeta", name: "Zeta", monitorCount: 0 },
      { id: "alpha", name: "alpha", monitorCount: 2 },
    ]
    expect(sortSettingsGroups(groups).map((group) => group.id)).toEqual([
      "alpha",
      "zeta",
    ])
    expect(groups.map((group) => group.id)).toEqual(["zeta", "alpha"])
  })

  it("creates explicit UTC expiries", () => {
    expect(expiryFromDays(30, new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "2026-01-31T00:00:00.000Z"
    )
  })

  it("parses newline and comma separated recipients", () => {
    expect(
      parseRecipients("a@example.com\nb@example.com, c@example.com")
    ).toEqual(["a@example.com", "b@example.com", "c@example.com"])
  })

  it("validates cross-field status and recipients", () => {
    expect(validateMonitorForm(valid)).toEqual({})
    expect(
      validateMonitorForm({
        ...valid,
        expectedStatusMax: 199,
        recipientsText: "bad",
      })
    ).toMatchObject({
      expectedStatusMax: expect.any(String),
      recipientsText: expect.any(String),
    })
  })

  it("identifies errors hidden inside advanced settings", () => {
    expect(
      hasAdvancedMonitorFormErrors({ timeoutMs: "Enter 1000–15000" })
    ).toBe(true)
    expect(hasAdvancedMonitorFormErrors({ name: "Enter a monitor name" })).toBe(
      false
    )
  })

  it("rejects private and reserved monitor targets", () => {
    expect(isPublicMonitorUrl("http://127.0.0.1/health")).toBe(false)
    expect(isPublicMonitorUrl("http://192.168.1.20/health")).toBe(false)
    expect(isPublicMonitorUrl("http://[::1]/health")).toBe(false)
    expect(isPublicMonitorUrl("https://example.com/health")).toBe(true)
  })

  it("adds a fresh idempotency key to mutations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    await apiRequest("/api/v1/tokens/token-id", { method: "DELETE" }, true)
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("Idempotency-Key")).toBe(
      "12345678-1234-1234-1234-123456789abc"
    )
  })

  it("preserves structured API error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "GROUP_NOT_EMPTY",
              message: "Move monitors first",
              details: { monitorCount: 2 },
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        )
      )
    )

    await expect(
      apiRequest("/api/v1/groups/core", { method: "DELETE" }, true)
    ).rejects.toMatchObject({
      code: "GROUP_NOT_EMPTY",
      details: { monitorCount: 2 },
    })
  })

  it("uses the exact configuration conflict copy", () => {
    expect(
      messageForError(
        new SettingsApiError("stale", 409, "CONFIG_VERSION_CONFLICT")
      )
    ).toBe("Configuration changed elsewhere. Reload before saving.")
  })

  it("reads monitor counts from non-empty group errors", () => {
    expect(
      groupDeleteBlockedCount(
        new SettingsApiError("blocked", 409, "GROUP_NOT_EMPTY", {
          monitorCount: 3,
        })
      )
    ).toBe(3)
    expect(
      groupDeleteBlockedCount(
        new SettingsApiError("missing", 404, "GROUP_NOT_FOUND")
      )
    ).toBeNull()
  })

  it("keeps edit-sheet header actions in test, state, archive order", () => {
    expect(monitorSheetActionLabels(true)).toEqual([
      "Run Test",
      "Pause",
      "Archive",
    ])
    expect(monitorSheetActionLabels(false)).toEqual([
      "Run Test",
      "Resume",
      "Archive",
    ])
  })
})
