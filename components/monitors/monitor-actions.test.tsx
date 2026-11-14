// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { MonitorTestOutcome } from "./monitor-test"

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }))
const runMonitorTest = vi.hoisted(() =>
  vi.fn<(monitorId: string) => Promise<MonitorTestOutcome>>()
)

vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("./monitor-test", () => ({ runMonitorTest }))

import {
  type EditableMonitor,
  MonitorActions,
  MonitorRunTestButton,
} from "./monitor-actions"

const monitor: EditableMonitor = {
  id: "api-prod",
  name: "API Production",
  url: "https://api.example.com/health",
  enabled: true,
  groupId: null,
  group: null,
  method: "GET",
  intervalMinutes: 1,
  timeoutMs: 8000,
  expectedStatusMin: 200,
  expectedStatusMax: 399,
  failureThreshold: 2,
  recoveryThreshold: 2,
  recipients: [],
}

function deferredOutcome() {
  let resolve: (outcome: MonitorTestOutcome) => void = () => undefined
  runMonitorTest.mockImplementation(
    () =>
      new Promise<MonitorTestOutcome>((done) => {
        resolve = done
      })
  )
  return (outcome: MonitorTestOutcome) => act(async () => resolve(outcome))
}

beforeEach(() => {
  router.refresh.mockReset()
  runMonitorTest.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("MonitorActions", () => {
  it("announces routine test progress and success to screen readers only", async () => {
    const settle = deferredOutcome()
    render(<MonitorActions canManageMonitors groups={[]} monitor={monitor} />)

    const region = screen.getByRole("status")
    expect(region.classList.contains("sr-only")).toBe(true)
    expect(region.textContent).toBe("")

    fireEvent.click(screen.getByRole("button", { name: "Test Monitor" }))
    expect(region.textContent).toBe("Checking…")

    await settle({ status: "success", message: "Monitor check passed" })

    expect(screen.getByRole("status")).toBe(region)
    expect(region.textContent).toBe("Monitor check passed")
    expect(region.classList.contains("sr-only")).toBe(true)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(router.refresh).toHaveBeenCalledOnce()
  })

  it("keeps a failed test visible", async () => {
    const settle = deferredOutcome()
    render(<MonitorActions canManageMonitors groups={[]} monitor={monitor} />)

    fireEvent.click(screen.getByRole("button", { name: "Test Monitor" }))
    await settle({
      status: "error",
      message: "Monitor check failed with HTTP 503",
    })

    const alert = screen.getByRole("alert")
    expect(alert.textContent).toBe("Monitor check failed with HTTP 503")
    expect(alert.classList.contains("sr-only")).toBe(false)
    expect(screen.getByRole("status").textContent).toBe("")
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it("announces pause to screen readers only and shows failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("crypto", { randomUUID: () => "key" })
    render(<MonitorActions canManageMonitors groups={[]} monitor={monitor} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause Monitor" }))
    })
    const region = screen.getByRole("status")
    expect(region.textContent).toBe("Monitor paused")
    expect(region.classList.contains("sr-only")).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause Monitor" }))
    })
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toBe(
      "Configuration changed elsewhere. Reload before trying again."
    )
    expect(alert.classList.contains("sr-only")).toBe(false)
  })
})

describe("MonitorRunTestButton", () => {
  it("keeps a passing setup test visible", async () => {
    const settle = deferredOutcome()
    render(<MonitorRunTestButton monitor={monitor} />)

    fireEvent.click(screen.getByRole("button", { name: "Run Test" }))
    await settle({ status: "success", message: "Monitor check passed" })

    const status = screen.getByRole("status")
    expect(status.textContent).toBe("Monitor check passed")
    expect(status.classList.contains("sr-only")).toBe(false)
  })
})
