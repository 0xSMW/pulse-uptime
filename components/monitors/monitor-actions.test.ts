// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))

vi.mock("next/navigation", () => ({ useRouter: () => router }))

import {
  type EditableMonitor,
  MonitorActions,
  MonitorEditButton,
  MonitorSetupActions,
} from "./monitor-actions"

beforeEach(() => {
  router.push.mockReset()
  router.refresh.mockReset()
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "")
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open")
    this.dispatchEvent(new Event("close"))
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

describe("manual test entry points", () => {
  function stubFailedProbe() {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          data: {
            successful: false,
            statusCode: 503,
            errorCode: "INVALID_STATUS",
          },
        },
        { status: 200 }
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  it("shows a failed probe from the header action", async () => {
    const fetchMock = stubFailedProbe()
    render(
      createElement(MonitorActions, {
        canManageMonitors: true,
        groups: [],
        monitor,
      })
    )

    fireEvent.click(screen.getByRole("button", { name: "Test Monitor" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("Monitor check failed with HTTP 503")
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/monitors/public-api/test"
    )
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it("shows a failed probe from the setup action", async () => {
    stubFailedProbe()
    render(
      createElement(MonitorSetupActions, {
        canManageMonitors: true,
        groups: [],
        monitor,
      })
    )

    fireEvent.click(screen.getByRole("button", { name: "Run Test" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("Monitor check failed with HTTP 503")
  })
})

describe("detail edit", () => {
  it("opens the shared monitor sheet with its field order", () => {
    render(
      createElement(MonitorEditButton, {
        canManageMonitors: true,
        groups: [],
        monitor,
      })
    )

    fireEvent.click(screen.getByRole("button", { name: "Edit Monitor" }))

    const sheet = screen.getByRole("dialog", { name: "Edit Monitor" })
    const url = screen.getByLabelText("URL")
    const name = screen.getByLabelText("Name")
    expect(sheet.contains(url)).toBe(true)
    expect(
      url.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Archive" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull()
  })

  it("prompts before discarding detail edits", () => {
    render(
      createElement(MonitorEditButton, {
        canManageMonitors: true,
        groups: [],
        monitor,
      })
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit Monitor" }))
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    })

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    expect(screen.queryByRole("dialog", { name: "Edit Monitor" })).toBeNull()
  })
})
