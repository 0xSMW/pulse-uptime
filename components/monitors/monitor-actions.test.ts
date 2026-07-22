import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

import {
  type EditableMonitor,
  hasAdvancedMonitorEditErrors,
  MonitorActions,
  MonitorEditButton,
  type MonitorEditValues,
  MonitorSetupActions,
  validateMonitorEdit,
} from "./monitor-actions"

const validValues: MonitorEditValues = {
  name: "Public API",
  url: "https://api.example.com/health",
  groupId: null,
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

const monitor: EditableMonitor = {
  id: "public-api",
  name: "Public API",
  url: "https://api.example.com/health",
  groupId: null,
  group: null,
  method: "GET",
  enabled: true,
  intervalMinutes: 1,
  timeoutMs: 8000,
  expectedStatusMin: 200,
  expectedStatusMax: 399,
  failureThreshold: 2,
  recoveryThreshold: 2,
  recipients: [],
}

describe("monitor mutation capabilities", () => {
  it("omits header and setup mutations for viewers", () => {
    const header = renderToStaticMarkup(
      createElement(MonitorActions, {
        canManageMonitors: false,
        groups: [],
        monitor,
      })
    )
    const setup = renderToStaticMarkup(
      createElement(MonitorSetupActions, {
        canManageMonitors: false,
        groups: [],
        monitor,
      })
    )
    const configuration = renderToStaticMarkup(
      createElement(MonitorEditButton, {
        canManageMonitors: false,
        groups: [],
        monitor,
      })
    )

    expect(header).toBe("")
    expect(setup).toBe("")
    expect(configuration).toBe("")
  })

  it("retains monitor mutations for admins", () => {
    const header = renderToStaticMarkup(
      createElement(MonitorActions, {
        canManageMonitors: true,
        groups: [],
        monitor,
      })
    )
    const setup = renderToStaticMarkup(
      createElement(MonitorSetupActions, {
        canManageMonitors: true,
        groups: [],
        monitor,
      })
    )
    const configuration = renderToStaticMarkup(
      createElement(MonitorEditButton, {
        canManageMonitors: true,
        groups: [],
        monitor,
      })
    )

    expect(header).toContain('aria-label="Test Monitor"')
    expect(header).toContain('aria-label="Pause Monitor"')
    expect(header).toContain('aria-label="Edit Monitor"')
    expect(setup).toContain("Run Test")
    expect(setup).toContain("Edit Monitor")
    expect(configuration).toContain("Edit Monitor")
  })
})

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
        recipients: "Enter valid email addresses",
      })
    ).toBe(true)
    expect(
      hasAdvancedMonitorEditErrors({ url: "Enter a public HTTP or HTTPS URL" })
    ).toBe(false)
  })
})
