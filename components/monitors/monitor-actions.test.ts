import { describe, expect, it } from "vitest"

import {
  hasAdvancedMonitorEditErrors,
  type MonitorEditValues,
  validateMonitorEdit,
} from "./monitor-actions"

const validValues: MonitorEditValues = {
  name: "Public API",
  url: "https://api.example.com/health",
  group: "Core",
  method: "GET",
  intervalMinutes: "1",
  timeoutMs: "8000",
  expectedStatusMin: "200",
  expectedStatusMax: "399",
  failureThreshold: "2",
  recoveryThreshold: "2",
  recipients: "ops@example.com\nowner@example.com",
  enabled: true,
}

describe("validateMonitorEdit", () => {
  it.each([
    "http://127.0.0.1/health",
    "http://10.0.0.1/health",
    "http://192.168.1.1/health",
    "http://203.0.113.10/health",
    "http://[::1]/health",
    "https://example.com:8443",
  ])("rejects private or reserved URL %s", (url) => {
    expect(validateMonitorEdit({ ...validValues, url }).url).toBe(
      "Enter a public HTTP or HTTPS URL"
    )
  })

  it("rejects a status maximum below the minimum", () => {
    expect(
      validateMonitorEdit({
        ...validValues,
        expectedStatusMin: "500",
        expectedStatusMax: "200",
      }).expectedStatusMax
    ).toBe("Maximum must be at least the minimum")
  })

  it("rejects duplicate recipients case-insensitively", () => {
    expect(
      validateMonitorEdit({
        ...validValues,
        recipients: "ops@example.com\nOPS@example.com",
      }).recipients
    ).toBe("Remove duplicate recipients")
  })

  it("accepts a complete valid form", () => {
    expect(validateMonitorEdit(validValues)).toEqual({})
  })

  it("identifies errors hidden inside advanced settings", () => {
    expect(
      hasAdvancedMonitorEditErrors({
        recipients: "Enter one valid email per line",
      })
    ).toBe(true)
    expect(
      hasAdvancedMonitorEditErrors({ url: "Enter a public HTTP or HTTPS URL" })
    ).toBe(false)
  })
})
