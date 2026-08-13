// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  deriveMonitorName,
  type EditableMonitor,
  isPublicMonitorUrl,
  MonitorSheet,
} from "./monitor-sheet"

const router = vi.hoisted(() => ({ refresh: vi.fn() }))

vi.mock("next/navigation", () => ({ useRouter: () => router }))

// jsdom does not implement HTMLDialogElement.showModal()/close() (both are
// undefined, not even throwing stubs). Polyfill the minimal behavior the
// Sheet depends on: toggling the `open` attribute/property, which jsdom's
// generic boolean-attribute reflection already handles once set.
beforeEach(() => {
  router.refresh.mockReset()
  vi.stubGlobal("crypto", {
    randomUUID: () => "12345678-1234-1234-1234-123456789abc",
  })
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const existingMonitor: EditableMonitor = {
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

function renderSheet(
  props: Partial<React.ComponentProps<typeof MonitorSheet>> = {}
) {
  return render(
    <MonitorSheet
      groups={[]}
      monitor={null}
      onClose={vi.fn()}
      onGroupCreated={vi.fn()}
      open
      {...props}
    />
  )
}

function urlInput(): HTMLInputElement {
  return screen.getByLabelText("URL") as HTMLInputElement
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("Name") as HTMLInputElement
}

describe("deriveMonitorName", () => {
  it("derives a cleaned hostname from the endpoint", () => {
    expect(deriveMonitorName("https://api.acme.dev/health")).toBe(
      "api.acme.dev"
    )
    expect(deriveMonitorName("https://www.acme.dev")).toBe("acme.dev")
    expect(deriveMonitorName("api.acme.dev/health")).toBe("api.acme.dev")
  })

  it("returns an empty name when no hostname can be derived", () => {
    expect(deriveMonitorName("")).toBe("")
    expect(deriveMonitorName("not a url")).toBe("")
  })
})

describe("isPublicMonitorUrl", () => {
  it.each([
    "http://203.0.113.10/health",
    "https://example.com:8443",
    "http://192.0.0.1/health",
    "http://[::ffff:192.168.0.1]/health",
    "http://localhost/health",
  ])("rejects private or reserved URL %s", (url) => {
    expect(isPublicMonitorUrl(url)).toBe(false)
  })

  it("accepts a public HTTPS URL", () => {
    expect(isPublicMonitorUrl("https://api.example.com/health")).toBe(true)
  })
})

describe("MonitorSheet", () => {
  it("puts the URL field before the name field", () => {
    renderSheet()
    const position = urlInput().compareDocumentPosition(nameInput())
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("derives the name from the URL until the name is edited manually", () => {
    renderSheet()
    fireEvent.change(urlInput(), {
      target: { value: "https://www.api.acme.dev/health" },
    })
    expect(nameInput().value).toBe("api.acme.dev")

    fireEvent.change(urlInput(), {
      target: { value: "https://status.acme.dev" },
    })
    expect(nameInput().value).toBe("status.acme.dev")

    fireEvent.change(nameInput(), { target: { value: "Custom Name" } })
    fireEvent.change(urlInput(), {
      target: { value: "https://other.example.dev" },
    })
    expect(nameInput().value).toBe("Custom Name")
  })

  it("never rewrites the name of an existing monitor", () => {
    renderSheet({ monitor: existingMonitor })
    fireEvent.change(urlInput(), {
      target: { value: "https://changed.example.com/health" },
    })
    expect(nameInput().value).toBe("API Production")
  })

  it("offers supplied groups through the group control", () => {
    renderSheet({
      groups: [{ id: "production", name: "Production", monitorCount: 1 }],
    })
    expect(screen.getByRole("combobox", { name: "Group" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Create Group" })).toBeNull()
  })

  it("falls back to group creation when no groups exist", () => {
    renderSheet()
    expect(screen.getByRole("button", { name: "Create Group" })).toBeDefined()
  })

  it("sends the exact create body and waits for propagation", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    const onClose = vi.fn()
    renderSheet({ onClose })

    fireEvent.change(urlInput(), {
      target: { value: "  https://api.example.com/health  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create Monitor" }))

    await act(async () => undefined)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/monitors")
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({
      id: "api-example-com-12345678",
      name: "api.example.com",
      url: "https://api.example.com/health",
      enabled: true,
      groupId: null,
      method: "GET",
      intervalMinutes: 1,
      timeoutMs: 8000,
      expectedStatus: { minimum: 200, maximum: 399 },
      failureThreshold: 2,
      recoveryThreshold: 2,
      recipients: [],
    })
    expect(screen.getByText("Updating configuration…")).toBeDefined()
    act(() => vi.advanceTimersByTime(9999))
    expect(router.refresh).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(router.refresh).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("focuses the first invalid field without sending a request", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderSheet()
    const url = urlInput()
    fireEvent.click(screen.getByRole("button", { name: "Create Monitor" }))

    await waitFor(() => expect(document.activeElement).toBe(url))
    expect(url.getAttribute("aria-invalid")).toBe("true")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("archives only after exact confirmation and waits 800 ms", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    const onClose = vi.fn()
    const onMonitorGroupChanged = vi.fn()
    renderSheet({ monitor: existingMonitor, onClose, onMonitorGroupChanged })

    fireEvent.click(screen.getByRole("button", { name: "Archive" }))
    const dialog = screen.getByRole("dialog", { name: "Archive Monitor" })
    const confirm = within(dialog).getByRole("button", {
      name: "Archive Monitor",
    })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: existingMonitor.name },
    })
    fireEvent.click(confirm)

    await act(async () => undefined)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/monitors/api-prod")
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" })
    expect(onMonitorGroupChanged).toHaveBeenCalledWith(null, null)
    act(() => vi.advanceTimersByTime(799))
    expect(onClose).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(router.refresh).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
