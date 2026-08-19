import { beforeEach, describe, expect, it, vi } from "vitest"
import { parseMonitorRecipients } from "@/lib/monitoring/recipients"

import {
  hasAdvancedMonitorFormErrors,
  isPublicMonitorUrl,
  type MonitorFormValues,
  monitorSheetActionLabels,
  validateMonitorForm,
} from "./monitor-sheet"
import {
  apiRequest,
  apiRequestWithResponse,
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
      parseMonitorRecipients("a@example.com\nb@example.com, c@example.com")
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

  it("keeps the numeric editor's maximum comparison when minimum is invalid", () => {
    expect(
      validateMonitorForm({
        ...valid,
        expectedStatusMin: 700,
        expectedStatusMax: 200,
      })
    ).toMatchObject({
      expectedStatusMin: "Enter 100–599",
      expectedStatusMax: "Enter a value from minimum to 599",
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
    await apiRequest(
      "/api/v1/tokens/token-id",
      { method: "DELETE" },
      { mutation: true }
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("Idempotency-Key")).toBe(
      "12345678-1234-1234-1234-123456789abc"
    )
  })

  it("supports conditional headers and response metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { name: "Saved" } }), {
        headers: { ETag: '"2"' },
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await apiRequestWithResponse<{ data: { name: string } }>(
      "/api/v1/status-page-config",
      { method: "PUT", body: JSON.stringify({ name: "Saved" }) },
      { idempotency: "fixed-key", ifMatch: '"1"' }
    )

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get("Accept")).toBe("application/json")
    expect(headers.get("Content-Type")).toBe("application/json")
    expect(headers.get("If-Match")).toBe('"1"')
    expect(headers.get("Idempotency-Key")).toBe("fixed-key")
    expect(result.data.data.name).toBe("Saved")
    expect(result.etag).toBe('"2"')
    expect(result.response.status).toBe(200)
  })

  it("leaves multipart content type for fetch to supply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { id: "image-id" } }))
    vi.stubGlobal("fetch", fetchMock)
    const form = new FormData()
    form.append("kind", "avatar")

    await apiRequest("/api/v1/images", { method: "POST", body: form })

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("Content-Type")).toBeNull()
    expect(headers.get("Idempotency-Key")).toBeNull()
  })

  it("supports request-specific non-JSON fallbacks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gateway", { status: 502 }))
    )

    await expect(
      apiRequest(
        "/api/v1/me",
        { method: "PATCH", body: JSON.stringify({ name: "Saved" }) },
        { fallbackMessage: "Request failed. Try again." }
      )
    ).rejects.toMatchObject({
      message: "Request failed. Try again.",
      status: 502,
    })
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
      apiRequest(
        "/api/v1/groups/core",
        { method: "DELETE" },
        { mutation: true }
      )
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
