// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import type { AttributedIncidentExclusion } from "@/lib/incidents/exclusion-attribution"
import { IncidentExclusions } from "./incident-exclusions"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

const exclusion: AttributedIncidentExclusion = {
  id: "exc-1",
  incidentId: "inc-1",
  monitorId: "mon-1",
  startAt: "2026-11-13T10:00:00.000Z",
  endAt: "2026-11-13T10:10:00.000Z",
  createdAt: "2026-11-13T11:00:00.000Z",
  reason: "Scheduled firewall test",
  createdByPrincipal: "human:admin",
  createdByLabel: "Taylor Morgan",
  revertedByLabel: null,
  revertedAt: null,
  revertedByPrincipal: null,
  affectedFailedChecks: 10,
}
const counts = {
  expectedChecks: 1440,
  completedChecks: 1440,
  successfulChecks: 1430,
  failedChecks: 10,
  unknownChecks: 0,
  excludedFailedChecks: 0,
  uptime: 99.305,
}
const preview = {
  incidentId: "inc-1",
  monitorId: "mon-1",
  startAt: exclusion.startAt,
  endAt: exclusion.endAt,
  affectedFailedChecks: 10,
  windowStart: "2026-11-12T11:00:00.000Z",
  windowEnd: exclusion.createdAt,
  before: counts,
  after: { ...counts, excludedFailedChecks: 10, uptime: 100 },
  previewVersion: "version-1",
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "")
  }
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(
  canManageMonitors = true,
  exclusions: AttributedIncidentExclusion[] = []
) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TimezoneProvider>
        <IncidentExclusions
          canManageMonitors={canManageMonitors}
          defaultEndAt={exclusion.endAt}
          defaultStartAt={exclusion.startAt}
          exclusions={exclusions}
          incidentId="inc-1"
          monitorId="mon-1"
        />
      </TimezoneProvider>
    </SWRConfig>
  )
}

function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 })
}

describe("incident exclusions", () => {
  it("hides mutation controls from viewers and preserves reverted audit history", () => {
    mount(false, [
      {
        ...exclusion,
        revertedAt: exclusion.createdAt,
        revertedByPrincipal: "human:owner",
        revertedByLabel: "Alex Morgan",
      },
    ])
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("Exclusion undone")).toBeTruthy()
    expect(screen.getByText("Scheduled firewall test")).toBeTruthy()
    expect(screen.getByText(/Taylor Morgan/)).toBeTruthy()
    expect(screen.queryByText(/human:/)).toBeNull()
    expect(screen.getByText(/Undone by Alex Morgan/)).toBeTruthy()
  })

  it("offers a new exclusion only after the active exclusion is undone", () => {
    const active = mount(true, [exclusion])
    expect(screen.getByText("Excluded")).toBeTruthy()
    expect(screen.queryByText("Excluded from downtime")).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Mark false alarm" })
    ).toBeNull()
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy()
    active.unmount()
    mount(true, [
      {
        ...exclusion,
        revertedAt: exclusion.createdAt,
        revertedByPrincipal: "human:owner",
        revertedByLabel: "Alex Morgan",
      },
    ])
    expect(
      screen.getByRole("button", { name: "Mark false alarm" })
    ).toBeTruthy()
  })

  it("previews the fixed range and requires a private reason", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(preview))
    vi.stubGlobal("fetch", fetcher)
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Mark false alarm" }))
    await screen.findByText("10 failed checks excluded")
    expect(screen.getByText(/99.305% → 100%/)).toBeTruthy()
    expect(screen.getByText(/^Window:/)).toBeTruthy()
    expect(screen.queryByText(/Completed window/)).toBeNull()
    expect(
      screen.queryByText(/older than 24 hours|Outside the last/)
    ).toBeNull()
    const submit = screen.getByRole("button", {
      name: "Exclude from downtime",
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({})
  })

  it("keeps the same idempotency key after a lost apply response", async () => {
    let applyCount = 0
    const keys: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/preview")) {
          return response(preview)
        }
        keys.push(new Headers(init.headers).get("Idempotency-Key")!)
        applyCount += 1
        if (applyCount === 1) {
          throw new Error("Connection interrupted")
        }
        return response(exclusion)
      })
    )
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Mark false alarm" }))
    await screen.findByText("10 failed checks excluded")
    fireEvent.change(screen.getByRole("textbox", { name: "Reason, private" }), {
      target: { value: "Scheduled firewall test" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Exclude from downtime" })
    )
    await screen.findByText("Connection interrupted")
    fireEvent.click(
      screen.getByRole("button", { name: "Exclude from downtime" })
    )
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it("previews a narrowed interval and blocks an invalid range", async () => {
    const fetcher = vi.fn().mockImplementation(async () => response(preview))
    vi.stubGlobal("fetch", fetcher)
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Mark false alarm" }))
    await screen.findByText("10 failed checks excluded")
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Choose a narrower interval" })
    )
    const start = screen.getByLabelText(/^Start, /) as HTMLInputElement
    const end = screen.getByLabelText(/^End, /) as HTMLInputElement
    fireEvent.change(start, { target: { value: end.value } })
    expect(screen.getByRole("alert").textContent).toBe(
      "Choose an end after the start"
    )
    expect(
      (
        screen.getByRole("button", {
          name: "Exclude from downtime",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    fireEvent.change(start, { target: { value: "2026-11-13T02:05" } })
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some((call) => {
          const body = JSON.parse(call[1].body)
          return body.startAt === new Date("2026-11-13T02:05").toISOString()
        })
      ).toBe(true)
    )
  })

  it("allows narrowing when the default preview has no retained evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Complete scheduled check evidence is unavailable",
              },
            }),
            { status: 409 }
          )
      )
    )
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Mark false alarm" }))
    await screen.findByText("Complete scheduled check evidence is unavailable")
    const narrow = screen.getByRole("checkbox", {
      name: "Choose a narrower interval",
    }) as HTMLInputElement
    expect(narrow.disabled).toBe(false)
    fireEvent.click(narrow)
    expect(screen.getByLabelText(/^Start, /)).toBeTruthy()
    expect(screen.getByLabelText(/^End, /)).toBeTruthy()
  })

  it("reads the narrowed interval in the selected display zone", async () => {
    window.localStorage.setItem("pulse-timezone-override", "America/New_York")
    const fetcher = vi.fn().mockImplementation(async () => response(preview))
    vi.stubGlobal("fetch", fetcher)
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Mark false alarm" }))
    await screen.findByText("10 failed checks excluded")
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Choose a narrower interval" })
    )
    const start = (await screen.findByLabelText(
      "Start, America/New_York"
    )) as HTMLInputElement
    expect(start.value).toBe("2026-11-13T05:00")
    expect(
      (screen.getByLabelText("End, America/New_York") as HTMLInputElement).value
    ).toBe("2026-11-13T05:10")
    fireEvent.change(start, { target: { value: "2026-11-13T05:05" } })
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          (call) =>
            JSON.parse(call[1].body).startAt === "2026-11-13T10:05:00.000Z"
        )
      ).toBe(true)
    )
  })

  it("blocks skipped and repeated clock-change times", async () => {
    window.localStorage.setItem("pulse-timezone-override", "America/New_York")
    const fetcher = vi.fn().mockImplementation(async () => response(preview))
    vi.stubGlobal("fetch", fetcher)
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Mark false alarm" }))
    await screen.findByText("10 failed checks excluded")
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Choose a narrower interval" })
    )
    const start = await screen.findByLabelText("Start, America/New_York")
    const end = screen.getByLabelText("End, America/New_York")
    fireEvent.change(end, { target: { value: "2026-11-13T05:10" } })
    fireEvent.change(start, { target: { value: "2026-03-08T02:30" } })
    expect(screen.getByRole("alert").textContent).toBe(
      "Start time is skipped by a clock change"
    )
    fireEvent.change(start, { target: { value: "2026-11-01T01:30" } })
    expect(screen.getByRole("alert").textContent).toBe(
      "Start time repeats at a clock change"
    )
    expect(
      (
        screen.getByRole("button", {
          name: "Exclude from downtime",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(screen.queryByText("10 failed checks excluded")).toBeNull()
    const bodies = fetcher.mock.calls.map((call) => JSON.parse(call[1].body))
    expect(
      bodies.some((body) => String(body.startAt).startsWith("2026-03-08"))
    ).toBe(false)
    expect(
      bodies.some((body) => String(body.startAt).startsWith("2026-11-01"))
    ).toBe(false)
  })

  it("keeps a repeated time that came from the incident itself", async () => {
    window.localStorage.setItem("pulse-timezone-override", "America/New_York")
    const repeated = {
      ...preview,
      startAt: "2026-11-01T06:30:00.000Z",
      endAt: "2026-11-01T06:50:00.000Z",
    }
    const fetcher = vi.fn().mockImplementation(async () => response(repeated))
    vi.stubGlobal("fetch", fetcher)
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Mark false alarm" }))
    await screen.findByText("10 failed checks excluded")
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Choose a narrower interval" })
    )
    const start = (await screen.findByLabelText(
      "Start, America/New_York"
    )) as HTMLInputElement
    expect(start.value).toBe("2026-11-01T01:30")
    expect(screen.queryByRole("alert")).toBeNull()
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          (call) =>
            JSON.parse(call[1].body).startAt === "2026-11-01T06:30:00.000Z"
        )
      ).toBe(true)
    )
  })

  it("names a single check and older checks outside the 24-hour window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          ...preview,
          startAt: "2026-11-01T10:00:00.000Z",
          endAt: "2026-11-01T10:01:00.000Z",
          affectedFailedChecks: 1,
          after: { ...counts },
        })
      )
    )
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Mark false alarm" }))
    await screen.findByText("1 failed check excluded")
    expect(
      screen.getByText(
        "Outside the last 24 hours, so only historical uptime changes"
      )
    ).toBeTruthy()
  })

  it("notes when only some checks fall inside the 24-hour window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          ...preview,
          startAt: "2026-11-12T10:00:00.000Z",
          affectedFailedChecks: 12,
          after: { ...counts, excludedFailedChecks: 4, uptime: 99.6 },
        })
      )
    )
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Mark false alarm" }))
    await screen.findByText("12 failed checks excluded")
    expect(
      screen.getByText(
        "Some are older than 24 hours, so historical uptime also changes"
      )
    ).toBeTruthy()
  })

  it("keeps the last preview visible with apply disabled while refreshing", async () => {
    let release: (value: Response) => void = () => undefined
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => response(preview))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          })
      )
    vi.stubGlobal("fetch", fetcher)
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Mark false alarm" }))
    await screen.findByText("10 failed checks excluded")
    const status = screen.getByRole("status")
    fireEvent.change(screen.getByRole("textbox", { name: "Reason, private" }), {
      target: { value: "Scheduled firewall test" },
    })
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Choose a narrower interval" })
    )
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(screen.getByText("10 failed checks excluded")).toBeTruthy()
    expect(screen.getByRole("status")).toBe(status)
    expect(status.getAttribute("aria-busy")).toBe("true")
    const submit = screen.getByRole("button", {
      name: "Exclude from downtime",
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    release(response({ ...preview, affectedFailedChecks: 1 }))
    await screen.findByText("1 failed check excluded")
    expect(screen.getByRole("status")).toBe(status)
    expect(status.getAttribute("aria-busy")).toBe("false")
    expect(submit.disabled).toBe(false)
  })

  it("undoes an active exclusion without deleting audit history", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ ...exclusion, revertedAt: exclusion.createdAt })
      )
    vi.stubGlobal("fetch", fetcher)
    mount(true, [exclusion])
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(fetcher).toHaveBeenCalled())
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/v1/incidents/inc-1/exclusions/exc-1/undo"
    )
    expect(screen.getByText("Scheduled firewall test")).toBeTruthy()
    expect(screen.getByText(/Taylor Morgan/)).toBeTruthy()
    expect(screen.queryByText(/human:/)).toBeNull()
  })
})
