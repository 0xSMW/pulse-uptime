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
import type { IncidentExclusionRecord } from "@/lib/incidents/exclusions"
import { IncidentExclusions } from "./incident-exclusions"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

const exclusion: IncidentExclusionRecord = {
  id: "exc-1",
  incidentId: "inc-1",
  monitorId: "mon-1",
  startAt: "2026-11-13T10:00:00.000Z",
  endAt: "2026-11-13T10:10:00.000Z",
  createdAt: "2026-11-13T11:00:00.000Z",
  reason: "Scheduled firewall test",
  createdByPrincipal: "user:admin",
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
  after: { ...counts, failedChecks: 0, uptime: 100 },
  previewVersion: "version-1",
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "")
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(
  canManageMonitors = true,
  exclusions: IncidentExclusionRecord[] = []
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
        revertedByPrincipal: "user:owner",
      },
    ])
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("Exclusion undone")).toBeTruthy()
    expect(screen.getByText("Scheduled firewall test")).toBeTruthy()
    expect(screen.getByText(/Undone by user:owner/)).toBeTruthy()
  })

  it("offers a new exclusion only after the active exclusion is undone", () => {
    const active = mount(true, [exclusion])
    expect(
      screen.queryByRole("button", { name: "Mark false alarm" })
    ).toBeNull()
    expect(screen.getByRole("button", { name: "Undo exclusion" })).toBeTruthy()
    active.unmount()
    mount(true, [
      {
        ...exclusion,
        revertedAt: exclusion.createdAt,
        revertedByPrincipal: "user:owner",
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
    expect(screen.getByText(/99.305% → 100.000%/)).toBeTruthy()
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
    const start = screen.getByLabelText("Start, local time") as HTMLInputElement
    const end = screen.getByLabelText("End, local time") as HTMLInputElement
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
    expect(screen.getByLabelText("Start, local time")).toBeTruthy()
    expect(screen.getByLabelText("End, local time")).toBeTruthy()
  })

  it("undoes an active exclusion without deleting audit history", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ ...exclusion, revertedAt: exclusion.createdAt })
      )
    vi.stubGlobal("fetch", fetcher)
    mount(true, [exclusion])
    fireEvent.click(screen.getByRole("button", { name: "Undo exclusion" }))
    await waitFor(() => expect(fetcher).toHaveBeenCalled())
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/v1/incidents/inc-1/exclusions/exc-1/undo"
    )
    expect(screen.getByText("Scheduled firewall test")).toBeTruthy()
  })
})
