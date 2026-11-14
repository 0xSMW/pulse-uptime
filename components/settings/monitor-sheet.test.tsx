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
  validateMonitorForm,
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

const SAVE_REASON = "Save changes before testing"
const REOPEN_REASON = "Reopen to load saved settings"

function testButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Run Test" }) as HTMLButtonElement
}

// The disabled test explains itself in visible form text, in the icon's
// accessible label, and in its accessible description, all with one reason.
function expectTestBlocked(reason: string) {
  const test = testButton()
  expect(test.disabled).toBe(true)
  const visible = screen.getByText(reason, { selector: "form p" })
  expect(visible.getAttribute("role")).toBe("status")
  expect(visible.classList.contains("sr-only")).toBe(false)
  expect(test.parentElement?.getAttribute("aria-label")).toBe(
    `Run Test. ${reason}`
  )
  const description = document.getElementById(
    test.getAttribute("aria-describedby") ?? ""
  )
  expect(description?.textContent).toBe(reason)
}

function expectTestAvailable() {
  expect(testButton().disabled).toBe(false)
  expect(screen.queryByText(SAVE_REASON)).toBeNull()
  expect(screen.queryByText(REOPEN_REASON)).toBeNull()
}

// Renders an editor whose monitor prop a later refresh can replace, the way
// router.refresh delivers another editor's saved change.
function renderRefreshableSheet() {
  const props = {
    groups: [],
    onClose: vi.fn(),
    onGroupCreated: vi.fn(),
    open: true,
  }
  const view = render(<MonitorSheet {...props} monitor={existingMonitor} />)
  return {
    refresh: (monitor: EditableMonitor) =>
      view.rerender(<MonitorSheet {...props} monitor={monitor} />),
  }
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
    const updating = screen.getByText("Updating configuration…")
    expect(updating.getAttribute("role")).toBe("status")
    expect(updating.classList.contains("sr-only")).toBe(true)
    const submit = screen.getByRole("button", {
      name: "Updating…",
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
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

  it("hands the archive to onArchived instead of refreshing", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    )
    const onClose = vi.fn()
    const onArchived = vi.fn()
    renderSheet({ monitor: existingMonitor, onArchived, onClose })

    fireEvent.click(screen.getByRole("button", { name: "Archive" }))
    const dialog = screen.getByRole("dialog", { name: "Archive Monitor" })
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: existingMonitor.name },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Archive Monitor" })
    )

    await act(async () => undefined)
    act(() => vi.advanceTimersByTime(800))
    expect(onArchived).toHaveBeenCalledOnce()
    expect(router.refresh).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("leaves pause and resume to the Enabled field", () => {
    renderSheet({ monitor: existingMonitor })
    expect(screen.getByRole("button", { name: "Run Test" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull()
    expect(screen.getByRole("checkbox", { name: "Enabled" })).toBeDefined()
  })

  it.each([
    [
      { successful: false, statusCode: 503, errorCode: "INVALID_STATUS" },
      "HTTP 503",
    ],
    [{ successful: false, statusCode: null, errorCode: "TIMEOUT" }, "TIMEOUT"],
  ])("reports a failed manual test %#", async (data, detail) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ data }, { status: 200 }))
    )
    renderSheet({ monitor: existingMonitor })

    fireEvent.click(screen.getByRole("button", { name: "Run Test" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe(`Monitor check failed with ${detail}`)
    expect(alert.classList.contains("sr-only")).toBe(false)
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it("announces a passing manual test to screen readers only", async () => {
    let respond: (response: Response) => void = () => undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve
          })
      )
    )
    renderSheet({ monitor: existingMonitor })

    fireEvent.click(screen.getByRole("button", { name: "Run Test" }))

    const testing = await screen.findByText("Testing…")
    expect(testing.getAttribute("role")).toBe("status")
    expect(testing.classList.contains("sr-only")).toBe(true)

    await act(async () => {
      respond(
        Response.json(
          { data: { successful: true, statusCode: 200, errorCode: null } },
          { status: 200 }
        )
      )
    })

    const status = await screen.findByText("Monitor check passed")
    expect(status).toBe(testing)
    expect(status.classList.contains("sr-only")).toBe(true)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(router.refresh).toHaveBeenCalledOnce()
  })

  it("closes a clean sheet without a prompt", () => {
    const onClose = vi.fn()
    renderSheet({ monitor: existingMonitor, onClose })

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" })
    ).toBeNull()
  })

  it("confirms before Escape discards unsaved edits", () => {
    const onClose = vi.fn()
    renderSheet({ monitor: existingMonitor, onClose })
    fireEvent.change(nameInput(), { target: { value: "Renamed" } })

    const sheet = screen.getByRole("dialog", { name: "Edit Monitor" })
    fireEvent(sheet, new Event("cancel", { cancelable: true }))

    const prompt = screen.getByRole("dialog", {
      name: "Discard unsaved changes?",
    })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(
      within(prompt).getByRole("button", { name: "Keep Editing" })
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(nameInput().value).toBe("Renamed")

    fireEvent.click(screen.getByRole("button", { name: "Close sheet" }))
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Discard unsaved changes?" })
      ).getByRole("button", { name: "Discard" })
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("blocks Run Test while probe fields differ from the saved config", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderSheet({ monitor: existingMonitor })
    const test = screen.getByRole("button", {
      name: "Run Test",
    }) as HTMLButtonElement

    fireEvent.change(nameInput(), { target: { value: "Renamed" } })
    expect(test.disabled).toBe(false)

    expect(screen.queryByText(SAVE_REASON)).toBeNull()

    fireEvent.change(urlInput(), {
      target: { value: "https://changed.example.com/health" },
    })
    expect(test.disabled).toBe(true)
    expectTestBlocked(SAVE_REASON)
    fireEvent.click(test)
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.change(urlInput(), { target: { value: existingMonitor.url } })
    expect(test.disabled).toBe(false)
    expect(screen.queryByText(SAVE_REASON)).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }))
    fireEvent.change(screen.getByLabelText("Expected Status Max"), {
      target: { value: "299" },
    })
    expect(test.disabled).toBe(true)
  })

  it("patches only edited fields over a refreshed monitor", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    const props = {
      groups: [],
      onClose: vi.fn(),
      onGroupCreated: vi.fn(),
      open: true,
    }
    const { rerender } = render(
      <MonitorSheet {...props} monitor={existingMonitor} />
    )
    fireEvent.change(nameInput(), { target: { value: "Renamed" } })
    // Another editor pauses the monitor and a refresh delivers it.
    rerender(
      <MonitorSheet
        {...props}
        monitor={{ ...existingMonitor, enabled: false }}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Save Monitor" }))
    await act(async () => undefined)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/monitors/api-prod")
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(String(init.body))).toEqual({ name: "Renamed" })
  })

  it.each([
    ["URL", { url: "https://moved.example.com/health" }],
    ["method", { method: "HEAD" }],
  ])("asks a clean sheet to reopen after a saved %s change", (_, change) => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { refresh } = renderRefreshableSheet()
    expectTestAvailable()

    refresh({ ...existingMonitor, ...change })

    expectTestBlocked(REOPEN_REASON)
    expect(screen.queryByText(SAVE_REASON)).toBeNull()
    fireEvent.click(testButton())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ["URL", { url: "https://moved.example.com/health" }],
    ["method", { method: "HEAD" }],
  ])(
    "keeps the reopen reason when only the name is edited and the saved %s changes",
    (_, change) => {
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)
      const { refresh } = renderRefreshableSheet()
      fireEvent.change(nameInput(), { target: { value: "Renamed" } })
      expectTestAvailable()

      refresh({ ...existingMonitor, ...change })

      expectTestBlocked(REOPEN_REASON)
      fireEvent.click(testButton())
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it("asks for a save when this editor's probe edit differs from the saved value", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { refresh } = renderRefreshableSheet()
    fireEvent.change(urlInput(), {
      target: { value: "https://mine.example.com/health" },
    })
    expectTestBlocked(SAVE_REASON)

    refresh({ ...existingMonitor, url: "https://theirs.example.com/health" })

    expectTestBlocked(SAVE_REASON)
    expect(screen.queryByText(REOPEN_REASON)).toBeNull()
    fireEvent.click(testButton())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("unblocks the test once the form matches newly saved probe settings", () => {
    const { refresh } = renderRefreshableSheet()
    const moved = "https://moved.example.com/health"
    refresh({ ...existingMonitor, url: moved })
    expectTestBlocked(REOPEN_REASON)

    fireEvent.change(urlInput(), { target: { value: moved } })

    expectTestAvailable()
  })

  it("unblocks a local probe edit when the same value is saved elsewhere", () => {
    const { refresh } = renderRefreshableSheet()
    const moved = "https://moved.example.com/health"
    fireEvent.change(urlInput(), { target: { value: moved } })
    expectTestBlocked(SAVE_REASON)

    refresh({ ...existingMonitor, url: moved })

    expectTestAvailable()
  })

  it("asks for a reopen when a local probe edit matches but another saved probe field changed", () => {
    const { refresh } = renderRefreshableSheet()
    const moved = "https://moved.example.com/health"
    fireEvent.change(urlInput(), { target: { value: moved } })

    refresh({ ...existingMonitor, url: moved, method: "HEAD" })

    expectTestBlocked(REOPEN_REASON)
  })

  it("runs the test after a refresh that changes only non-probe settings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { data: { successful: true, statusCode: 200, errorCode: null } },
          { status: 200 }
        )
      )
    vi.stubGlobal("fetch", fetchMock)
    const { refresh } = renderRefreshableSheet()
    fireEvent.change(nameInput(), { target: { value: "Renamed" } })

    refresh({ ...existingMonitor, name: "Theirs", enabled: false })

    expectTestAvailable()
    fireEvent.click(testButton())
    await screen.findByText("Monitor check passed")
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("sends the whole expected status range when one bound changes", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    renderSheet({ monitor: existingMonitor })

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }))
    fireEvent.change(screen.getByLabelText("Expected Status Max"), {
      target: { value: "299" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Monitor" }))
    await act(async () => undefined)

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({
      expectedStatus: { minimum: 200, maximum: 299 },
    })
  })

  it("closes without a request when edits change nothing saved", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const onClose = vi.fn()
    renderSheet({ monitor: existingMonitor, onClose })

    fireEvent.change(urlInput(), {
      target: { value: `  ${existingMonitor.url}  ` },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Monitor" }))
    await act(async () => undefined)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("keeps sheet test status out of the archive dialog", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { data: { successful: true, statusCode: 200, errorCode: null } },
            { status: 200 }
          )
        )
    )
    renderSheet({ monitor: existingMonitor })
    fireEvent.click(screen.getByRole("button", { name: "Run Test" }))
    await screen.findByText("Monitor check passed")

    fireEvent.click(screen.getByRole("button", { name: "Archive" }))
    const dialog = screen.getByRole("dialog", { name: "Archive Monitor" })
    expect(within(dialog).queryByText("Monitor check passed")).toBeNull()
    expect(within(dialog).queryByRole("status")).toBeNull()
  })

  it("clears an archive failure when the dialog reopens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: { code: "EDGE_CONFIG_UNAVAILABLE", message: "Try later" },
          },
          { status: 503 }
        )
      )
    )
    renderSheet({ monitor: existingMonitor })

    fireEvent.click(screen.getByRole("button", { name: "Archive" }))
    let dialog = screen.getByRole("dialog", { name: "Archive Monitor" })
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: existingMonitor.name },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Archive Monitor" })
    )
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Try later"
    )
    // The failure belongs to the dialog, not the sheet form.
    expect(screen.getAllByText("Try later")).toHaveLength(1)

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: "Archive" }))
    dialog = screen.getByRole("dialog", { name: "Archive Monitor" })
    expect(within(dialog).queryByRole("alert")).toBeNull()
  })

  it("treats a reverted edit as clean", () => {
    const onClose = vi.fn()
    renderSheet({ monitor: existingMonitor, onClose })
    fireEvent.change(nameInput(), { target: { value: "Renamed" } })
    fireEvent.change(nameInput(), { target: { value: existingMonitor.name } })

    fireEvent.click(screen.getByRole("button", { name: "Close sheet" }))

    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe("validateMonitorForm", () => {
  const valid = {
    name: "Public API",
    url: "https://api.example.com/health",
    enabled: true,
    groupId: null,
    method: "GET",
    intervalMinutes: 1,
    timeoutMs: 8000,
    expectedStatusMin: 200,
    expectedStatusMax: 399,
    failureThreshold: 2,
    recoveryThreshold: 2,
    recipientsText: "ops@example.com\nowner@example.com",
  }

  it.each([
    "http://127.0.0.1/health",
    "http://10.0.0.1/health",
    "http://192.168.1.1/health",
    "http://[::1]/health",
  ])("rejects private URL %s", (url) => {
    expect(validateMonitorForm({ ...valid, url }).url).toBeDefined()
  })

  it("rejects a status maximum below the minimum", () => {
    expect(
      validateMonitorForm({
        ...valid,
        expectedStatusMin: 500,
        expectedStatusMax: 200,
      }).expectedStatusMax
    ).toBeDefined()
  })

  it("rejects duplicate recipients case-insensitively", () => {
    expect(
      validateMonitorForm({
        ...valid,
        recipientsText: "ops@example.com\nOPS@example.com",
      }).recipientsText
    ).toBe("Remove duplicate recipients")
  })

  it("accepts a complete valid form", () => {
    expect(validateMonitorForm(valid)).toEqual({})
  })
})
