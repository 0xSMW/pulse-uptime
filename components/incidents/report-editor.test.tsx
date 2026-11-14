// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, refresh: navigation.refresh }),
}))

// jsdom has no layout engine, so Radix Select's scroll-into-view and pointer
// capture calls are unimplemented. Stub them so opening a Select in tests
// doesn't throw.
//
// jsdom also does not implement HTMLDialogElement.showModal()/close() (both
// are undefined, not even throwing stubs). The discard-changes ConfirmDialog
// needs those, so polyfill the minimal behavior it depends on: toggling the
// `open` attribute/property, which jsdom's generic boolean-attribute
// reflection already handles once set.
beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {
    // jsdom stub
  }
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {
    // jsdom stub
  }
  Element.prototype.releasePointerCapture ??= () => {
    // jsdom stub
  }
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "")
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open")
    this.dispatchEvent(new Event("close"))
  }
})

function isDialogOpen(): boolean {
  return document.querySelector("dialog")?.open ?? false
}

import {
  TIMEZONE_STORAGE_KEY,
  TimezoneProvider,
} from "@/components/dashboard/timezone-provider"
import {
  ReportEditor,
  type ReportEditorMonitor,
  UNSAVED_CHANGES_MESSAGE,
} from "./report-editor"
import type { ReportData } from "./report-status"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const monitors: ReportEditorMonitor[] = [
  { id: "api-prod", name: "API Production", group: "Core" },
  { id: "marketing", name: "Marketing site", group: null },
]

const report: ReportData = {
  id: "rep-1",
  type: "incident",
  title: "Elevated API error rates",
  startsAt: "2026-07-18T09:00:00.000Z",
  endsAt: null,
  publishedAt: null,
  resolvedAt: "2026-07-18T12:00:00.000Z",
  originIncidentId: null,
  currentStatus: "resolved",
  updates: [
    {
      id: "u2",
      status: "resolved",
      markdown: "All clear.",
      publishedAt: "2026-07-18T12:00:00.000Z",
      createdAt: "2026-07-18T12:00:00.000Z",
    },
    {
      id: "u1",
      status: "monitoring",
      markdown: "Watching recovery.",
      publishedAt: "2026-07-18T10:00:00.000Z",
      createdAt: "2026-07-18T10:00:00.000Z",
    },
  ],
  affected: [
    {
      monitorId: "api-prod",
      monitorName: "API Production",
      groupName: "Core",
      impact: "down",
    },
  ],
  createdAt: "2026-07-18T09:00:00.000Z",
  updatedAt: "2026-07-18T12:00:00.000Z",
}

function okEnvelope(data: unknown) {
  return new Response(
    JSON.stringify({ apiVersion: "v1", kind: "StatusReport", data }),
    { status: 200 }
  )
}

// A fixed display zone keeps typed wall times independent of the machine.
function renderEditor(target: ReportData | null) {
  return render(
    <TimezoneProvider defaultTimezone="UTC">
      <ReportEditor monitors={monitors} report={target} />
    </TimezoneProvider>
  )
}

describe("ReportEditor create mode", () => {
  it("requires a title and an initial update before posting", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(null)
    fireEvent.click(screen.getByRole("button", { name: "Publish Report" }))
    expect(screen.getByText("Enter a title")).toBeDefined()
    expect(screen.getByText("Write the first update")).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("hides the maintenance end field for incident reports", () => {
    renderEditor(null)
    expect(screen.getByLabelText(/^Starts at/)).toBeDefined()
    expect(screen.queryByLabelText(/^Ends at/)).toBeNull()
    expect(screen.getByText("You can use markdown.")).toBeDefined()
    expect(screen.getByLabelText("Save as draft")).toBeDefined()
  })

  it("creates the report and navigates to its editor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "rep-9" } }), { status: 201 })
      )
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(null)
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "API outage" },
    })
    fireEvent.change(screen.getByLabelText("Initial update"), {
      target: { value: "We are investigating." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Publish Report" }))
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith("/incidents/reports/rep-9")
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/v1/status-reports")
    const body = JSON.parse(String(init.body)) as {
      type: string
      draft?: boolean
      update: { markdown: string }
    }
    expect(body.type).toBe("incident")
    expect(body.draft).toBeUndefined()
    expect(body.update.markdown).toBe("We are investigating.")
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeTruthy()
  })

  it("names the create button by outcome and sends draft when saving a draft", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "rep-3" } }), { status: 201 })
      )
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(null)
    expect(screen.getByRole("button", { name: "Publish Report" })).toBeDefined()
    fireEvent.click(screen.getByLabelText("Save as draft"))
    expect(screen.queryByRole("button", { name: "Publish Report" })).toBeNull()
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "API outage" },
    })
    fireEvent.change(screen.getByLabelText("Initial update"), {
      target: { value: "We are investigating." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }))
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith("/incidents/reports/rep-3")
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { draft?: boolean }
    expect(body.draft).toBe(true)
  })

  it("shows a publish failure in the header beside the publish action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "ALREADY_PUBLISHED", message: "Already" },
          }),
          { status: 409 }
        )
      )
    )
    renderEditor(report)
    const header = screen
      .getByRole("heading", { name: "Edit status report" })
      .closest("header")!
    fireEvent.click(within(header).getByRole("button", { name: "Publish" }))
    fireEvent.click(within(header).getByRole("button", { name: "Confirm" }))
    await waitFor(() => {
      expect(
        within(header).getByText("This report is already published.")
      ).toBeDefined()
    })
  })

  it("shows a post failure beside Post Update", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "REPORT_NOT_FOUND", message: "Gone" },
          }),
          { status: 404 }
        )
      )
    )
    renderEditor(report)
    fireEvent.change(screen.getByLabelText("New update"), {
      target: { value: "Postmortem coming." },
    })
    const button = screen.getByRole("button", { name: "Post Update" })
    fireEvent.click(button)
    await waitFor(() => {
      expect(
        within(button.parentElement!).getByText("This report no longer exists.")
      ).toBeDefined()
    })
  })
})

describe("ReportEditor display time zone", () => {
  function setBangkokOverride() {
    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, "Asia/Bangkok")
  }

  it("labels datetime fields with the zone and shows times in it", async () => {
    setBangkokOverride()
    renderEditor(report)
    await waitFor(() => {
      expect(screen.getByLabelText("Starts at (Asia/Bangkok)")).toBeDefined()
    })
    expect(
      (screen.getByLabelText(/^Starts at/) as HTMLInputElement).value
    ).toBe("2026-07-18T16:00")
    expect(screen.getByLabelText("Published at (Asia/Bangkok)")).toBeDefined()
    const row = screen.getByText("Watching recovery.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    expect(
      (
        screen.getByLabelText(/^Published at/, {
          selector: "#edit-published-u1",
        }) as HTMLInputElement
      ).value
    ).toBe("2026-07-18T17:00")
  })

  it("reads typed times in the display zone when saving", async () => {
    setBangkokOverride()
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    await waitFor(() => {
      expect(screen.getByLabelText("Starts at (Asia/Bangkok)")).toBeDefined()
    })
    fireEvent.change(screen.getByLabelText(/^Starts at/), {
      target: { value: "2026-07-10T08:00" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { startsAt?: string }
    expect(body.startsAt).toBe("2026-07-10T01:00:00.000Z")
  })

  it("keeps an untouched update time out of the PATCH in a non-local zone", async () => {
    setBangkokOverride()
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    await waitFor(() => {
      expect(screen.getByLabelText("Starts at (Asia/Bangkok)")).toBeDefined()
    })
    const row = screen.getByText("Watching recovery.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    fireEvent.change(
      screen.getByLabelText("Update", { selector: "#edit-markdown-u1" }),
      { target: { value: "Recovery confirmed." } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect("publishedAt" in body).toBe(false)
  })

  // 06:30Z is 01:30 EST, the second pass of the repeated fall-back hour.
  const fallBackReport: ReportData = {
    ...report,
    startsAt: "2026-11-01T06:30:00.000Z",
    updates: [
      {
        id: "u1",
        status: "monitoring",
        markdown: "Watching recovery.",
        publishedAt: "2026-11-01T06:45:00.000Z",
        createdAt: "2026-11-01T06:45:00.000Z",
      },
    ],
  }

  async function renderNewYork(target: ReportData) {
    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, "America/New_York")
    renderEditor(target)
    await waitFor(() => {
      expect(
        screen.getByLabelText("Starts at (America/New_York)")
      ).toBeDefined()
    })
  }

  it("saves around an untouched repeated start time", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(fallBackReport))
    vi.stubGlobal("fetch", fetchMock)
    await renderNewYork(fallBackReport)
    expect(
      (screen.getByLabelText(/^Starts at/) as HTMLInputElement).value
    ).toBe("2026-11-01T01:30")
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ title: "Retitled report" })
  })

  it("rejects a newly typed repeated start time", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await renderNewYork(report)
    fireEvent.change(screen.getByLabelText(/^Starts at/), {
      target: { value: "2026-11-01T01:15" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))
    expect(screen.getByText("Time repeats at clock change")).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("flags a newly typed skipped update time on its field", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await renderNewYork(fallBackReport)
    const row = screen.getByText("Watching recovery.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    const input = screen.getByLabelText(/^Published at/, {
      selector: "#edit-published-u1",
    })
    fireEvent.change(input, { target: { value: "2026-03-08T02:30" } })
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }))
    expect(within(row).getByText("Time skipped at clock change")).toBeDefined()
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("keeps an untouched repeated update time out of the PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(fallBackReport))
    vi.stubGlobal("fetch", fetchMock)
    await renderNewYork(fallBackReport)
    const row = screen.getByText("Watching recovery.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    expect(
      within(row).queryByText(
        "This update is dated before the report's start time"
      )
    ).toBeNull()
    fireEvent.change(
      screen.getByLabelText("Update", { selector: "#edit-markdown-u1" }),
      { target: { value: "Recovery confirmed." } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      markdown: "Recovery confirmed.",
    })
  })
})

describe("ReportEditor edit mode", () => {
  it("shows the maintenance end field for maintenance reports and locks type", () => {
    renderEditor({
      ...report,
      type: "maintenance",
      currentStatus: "in_progress",
      updates: [
        {
          id: "u1",
          status: "in_progress",
          markdown: "Underway.",
          publishedAt: "2026-07-18T10:00:00.000Z",
        },
      ],
      resolvedAt: null,
    })
    expect(screen.getByLabelText(/^Ends at/)).toBeDefined()
    const optional = screen.getByText("Optional")
    expect(optional.classList.contains("sr-only")).toBe(false)
    expect(screen.queryByText(/leave empty if open-ended/)).toBeNull()
    const locked = screen.getByText("Type is locked after creation")
    expect(locked.classList.contains("sr-only")).toBe(true)
    const typeTrigger = screen.getByRole("combobox", { name: "Type" })
    expect((typeTrigger as HTMLButtonElement).disabled).toBe(true)
    expect(typeTrigger.getAttribute("aria-describedby")).toBe(locked.id)
  })

  it("drops the timeline descriptions that repeat the publish flow", () => {
    renderEditor(report)
    expect(screen.getByText("Update Timeline")).toBeDefined()
    expect(screen.queryByText(/updates render on your status page/)).toBeNull()
    expect(
      screen.queryByText("The first update publishes with the report")
    ).toBeNull()
  })

  it("renders the timeline newest-first with a draft badge and group sections", () => {
    renderEditor(report)
    expect(screen.getByText("Draft")).toBeDefined()
    expect(screen.getByText("All clear.")).toBeDefined()
    expect(screen.getByText("Watching recovery.")).toBeDefined()
    expect(screen.getByText("Core")).toBeDefined()
    expect(screen.getByText("Ungrouped")).toBeDefined()
    expect(screen.getByLabelText("Impact for API Production")).toBeDefined()
  })

  it("warns before a backdate flips the report to Ongoing, then saves on confirm", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    const row = screen.getByText("All clear.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    fireEvent.change(
      screen.getByLabelText(/^Published at/, {
        selector: "#edit-published-u2",
      }),
      {
        target: { value: "2026-07-17T09:00" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }))
    expect(
      screen.getByText(
        "This moves the report back to Ongoing — it will reappear at the top of your status page."
      )
    ).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Save Anyway" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1/updates/u2",
        expect.objectContaining({ method: "PATCH" })
      )
    })
  })

  it("saves without a warning when the state does not flip", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    const row = screen.getByText("Watching recovery.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    fireEvent.change(
      screen.getByLabelText("Update", { selector: "#edit-markdown-u1" }),
      {
        target: { value: "Recovery confirmed." },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1/updates/u1",
        expect.objectContaining({ method: "PATCH" })
      )
    })
  })

  it("surfaces LAST_UPDATE when deleting the only update", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "LAST_UPDATE",
            message: "A report must keep at least one update",
          },
        }),
        { status: 409 }
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    renderEditor({
      ...report,
      updates: [
        {
          id: "u1",
          status: "resolved",
          markdown: "All clear.",
          publishedAt: "2026-07-18T12:00:00.000Z",
        },
      ],
    })
    const row = screen.getByText("All clear.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }))
    expect(within(row).getByText("Delete update?")).toBeDefined()
    fireEvent.click(within(row).getByRole("button", { name: "Confirm" }))
    await waitFor(() => {
      expect(
        within(row).getByText(
          "A report must keep at least one update — delete the report instead."
        )
      ).toBeDefined()
    })
    const alert = within(row).getByRole("alert")
    expect(alert.classList.contains("sr-only")).toBe(false)
  })

  it("announces a deleted update without a visible list item", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    )
    renderEditor(report)
    const row = screen.getByText("All clear.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }))
    fireEvent.click(within(row).getByRole("button", { name: "Confirm" }))
    const status = await screen.findByText("Update deleted")
    expect(status.getAttribute("role")).toBe("status")
    expect(status.classList.contains("sr-only")).toBe(true)
    const item = status.closest("li")!
    expect(item.classList.contains("sr-only")).toBe(true)
  })

  it("requires confirmation, stating public visibility, before publishing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okEnvelope({ ...report, publishedAt: "2026-07-18T13:00:00.000Z" })
      )
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    fireEvent.click(screen.getByRole("button", { name: "Publish" }))
    expect(
      screen.getByText(
        "Publishing makes this report publicly visible on your status page."
      )
    ).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1/publish",
        expect.objectContaining({ method: "POST" })
      )
      expect(screen.getByText("Report published")).toBeDefined()
    })
    const published = screen.getByText("Report published")
    expect(published.getAttribute("role")).toBe("status")
    // Only the sr-only class, so no full-width row is left in the header
    expect(published.className).toBe("sr-only")
  })

  it("deletes the report after a two-step confirm and returns to the list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    const header = screen
      .getByRole("heading", { name: "Edit status report" })
      .closest("header")!
    fireEvent.click(within(header).getByRole("button", { name: "Delete" }))
    expect(within(header).getByText("Delete report?")).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(within(header).getByRole("button", { name: "Confirm" }))
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith("/incidents/reports")
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/status-reports/rep-1",
      expect.objectContaining({ method: "DELETE" })
    )
  })

  it("posts a composer update scoped to the report", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    fireEvent.change(screen.getByLabelText("New update"), {
      target: { value: "Postmortem coming." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Post Update" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1/updates",
        expect.objectContaining({ method: "POST" })
      )
      expect(screen.getByText("Update posted")).toBeDefined()
    })
    const posted = screen.getByText("Update posted")
    expect(posted.getAttribute("role")).toBe("status")
    expect(posted.classList.contains("sr-only")).toBe(true)
  })

  it("omits publishedAt from the PATCH when only the markdown changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    const row = screen.getByText("Watching recovery.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    fireEvent.change(
      screen.getByLabelText("Update", { selector: "#edit-markdown-u1" }),
      {
        target: { value: "Recovery confirmed." },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.markdown).toBe("Recovery confirmed.")
    expect("publishedAt" in body).toBe(false)
  })

  it("omits status and markdown from the PATCH when only publishedAt changed (finding: an unchanged page-load status/markdown clobbers a concurrent edit)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    const row = screen.getByText("Watching recovery.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    // Moves publishedAt later but still well before u2 (resolved), so no
    // state flip and no confirmation gate to click through first.
    fireEvent.change(
      screen.getByLabelText(/^Published at/, {
        selector: "#edit-published-u1",
      }),
      {
        target: { value: "2026-07-18T11:00" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1/updates/u1",
        expect.objectContaining({ method: "PATCH" })
      )
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect("status" in body).toBe(false)
    expect("markdown" in body).toBe(false)
    expect(typeof body.publishedAt).toBe("string")
  })

  it("omits affected from the PATCH when only the title changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1",
        expect.objectContaining({ method: "PATCH" })
      )
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.title).toBe("Retitled report")
    expect("affected" in body).toBe(false)
    const saved = await screen.findByText("Report saved")
    expect(saved.classList.contains("sr-only")).toBe(false)
  })

  it("omits startsAt/endsAt from the PATCH when only the title changed (finding: an untouched datetime-local value silently truncates seconds)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor({
      ...report,
      type: "maintenance",
      endsAt: "2026-07-18T15:00:00.000Z",
    })
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1",
        expect.objectContaining({ method: "PATCH" })
      )
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.title).toBe("Retitled report")
    expect("startsAt" in body).toBe(false)
    expect("endsAt" in body).toBe(false)
  })

  it("sends startsAt when the start time actually changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    fireEvent.change(screen.getByLabelText(/^Starts at/), {
      target: { value: "2026-07-10T08:00" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1",
        expect.objectContaining({ method: "PATCH" })
      )
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect("startsAt" in body).toBe(true)
    expect(typeof body.startsAt).toBe("string")
  })

  it("omits title from the PATCH when only affected changed (finding: an unchanged page-load title clobbers a concurrent title edit)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    fireEvent.click(screen.getByLabelText("Impact for Marketing site"))
    fireEvent.click(await screen.findByRole("option", { name: "Degraded" }))
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1",
        expect.objectContaining({ method: "PATCH" })
      )
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect("title" in body).toBe(false)
    expect(body.affected).toBeDefined()
  })

  it("still sends the full affected replacement when the impact picker changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(report)
    fireEvent.click(screen.getByLabelText("Impact for Marketing site"))
    fireEvent.click(await screen.findByRole("option", { name: "Degraded" }))
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1",
        expect.objectContaining({ method: "PATCH" })
      )
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      affected?: Array<{ monitorId: string; impact: string }>
    }
    expect(body.affected).toEqual(
      expect.arrayContaining([
        { monitorId: "api-prod", impact: "down" },
        { monitorId: "marketing", impact: "degraded" },
      ])
    )
  })

  it("warns inside the delete confirm when removing the resolving update reopens the report", () => {
    renderEditor(report)
    const row = screen.getByText("All clear.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }))
    expect(within(row).getByText("Delete update?")).toBeDefined()
    expect(
      within(row).getByText(
        "This moves the report back to Ongoing — it will reappear at the top of your status page."
      )
    ).toBeDefined()
  })

  it("warns when the composer update is dated before the report start", () => {
    renderEditor(report)
    fireEvent.change(screen.getByLabelText(/^Published at/), {
      target: { value: "2026-07-01T08:00" },
    })
    expect(
      screen.getByText("This update is dated before the report's start time")
    ).toBeDefined()
    fireEvent.change(screen.getByLabelText(/^Published at/), {
      target: { value: "2026-07-19T08:00" },
    })
    expect(
      screen.queryByText("This update is dated before the report's start time")
    ).toBeNull()
  })

  it("warns in the edit form when publishedAt predates the report start", () => {
    renderEditor(report)
    const row = screen.getByText("Watching recovery.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    fireEvent.change(
      screen.getByLabelText(/^Published at/, {
        selector: "#edit-published-u1",
      }),
      {
        target: { value: "2026-07-01T08:00" },
      }
    )
    expect(
      within(row).getByText(
        "This update is dated before the report's start time"
      )
    ).toBeDefined()
  })
})

describe("ReportEditor unsaved-changes protection", () => {
  it("disables Save Changes until basics change", () => {
    renderEditor(report)
    expect(
      (
        screen.getByRole("button", {
          name: "Save Changes",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    expect(
      (
        screen.getByRole("button", {
          name: "Save Changes",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: report.title },
    })
    expect(
      (
        screen.getByRole("button", {
          name: "Save Changes",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("guards navigation once the start time changes", () => {
    renderEditor(report)
    const addSpy = vi.spyOn(window, "addEventListener")
    fireEvent.change(screen.getByLabelText(/^Starts at/), {
      target: { value: "2026-07-10T08:00" },
    })
    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function))
  })

  it("guards and clears as composer text changes", () => {
    renderEditor(report)
    const addSpy = vi.spyOn(window, "addEventListener")
    fireEvent.change(screen.getByLabelText("New update"), {
      target: { value: "Draft in progress" },
    })
    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function))
    const removeSpy = vi.spyOn(window, "removeEventListener")
    fireEvent.change(screen.getByLabelText("New update"), {
      target: { value: "" },
    })
    expect(removeSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function))
  })

  it("guards an open update edit and clears on cancel", () => {
    renderEditor(report)
    const row = screen.getByText("Watching recovery.").closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }))
    const addSpy = vi.spyOn(window, "addEventListener")
    fireEvent.change(
      screen.getByLabelText("Update", { selector: "#edit-markdown-u1" }),
      {
        target: { value: "Changed body." },
      }
    )
    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function))
    const removeSpy = vi.spyOn(window, "removeEventListener")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(removeSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function))
  })

  it("registers a beforeunload guard while dirty", () => {
    renderEditor(report)
    const addSpy = vi.spyOn(window, "addEventListener")
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function))
    const removeSpy = vi.spyOn(window, "removeEventListener")
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: report.title },
    })
    expect(removeSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function))
  })

  it("re-pushes the sentinel and opens the discard dialog on browser Back/Forward (popstate) while dirty", () => {
    renderEditor(report)
    const pushStateSpy = vi.spyOn(window.history, "pushState")
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    const pushesBeforePop = pushStateSpy.mock.calls.length
    fireEvent(window, new PopStateEvent("popstate"))
    // Sentinel restored before the dialog is shown, not after a confirm/cancel.
    expect(pushStateSpy.mock.calls.length).toBe(pushesBeforePop + 1)
    expect(isDialogOpen()).toBe(true)
    expect(
      screen.getByRole("heading", { name: "Discard unsaved changes?" })
    ).toBeDefined()
    expect(screen.getByText(UNSAVED_CHANGES_MESSAGE)).toBeDefined()
  })

  it("does not open the discard dialog on popstate once the form is clean again", () => {
    renderEditor(report)
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: report.title },
    })
    fireEvent(window, new PopStateEvent("popstate"))
    expect(isDialogOpen()).toBe(false)
  })

  it("opens the discard dialog exactly once on a click for a link outside the editor (e.g. TopNav) while dirty", () => {
    // The editor's guard is a document-wide click listener (via
    // useNavigationGuard), so it also covers links it did not render itself:
    // simulate a TopNav-style link elsewhere in the document and confirm it
    // is caught, and caught only once (no double-prompt).
    renderEditor(report)
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    const topNavLink = document.createElement("a")
    topNavLink.href = "/settings"
    topNavLink.textContent = "Settings"
    document.body.appendChild(topNavLink)
    const click = fireEvent(
      topNavLink,
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    )
    expect(click).toBe(false)
    expect(document.querySelectorAll("dialog[open]")).toHaveLength(1)
    topNavLink.remove()
  })

  it("navigates through the router after confirming Discard on a link click", () => {
    renderEditor(report)
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    const topNavLink = document.createElement("a")
    topNavLink.href = "/settings"
    document.body.appendChild(topNavLink)
    fireEvent(
      topNavLink,
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    )

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    expect(navigation.push).toHaveBeenCalledWith("/settings")
    expect(isDialogOpen()).toBe(false)
    topNavLink.remove()
  })

  it("keeps editing (no navigation) when Keep Editing is clicked", () => {
    renderEditor(report)
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    const topNavLink = document.createElement("a")
    topNavLink.href = "/settings"
    document.body.appendChild(topNavLink)
    fireEvent(
      topNavLink,
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    )

    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }))

    expect(navigation.push).not.toHaveBeenCalled()
    expect(isDialogOpen()).toBe(false)
    topNavLink.remove()
  })

  it("completes the exit with history.go(-2) after confirming Discard on popstate", () => {
    renderEditor(report)
    const goSpy = vi.spyOn(window.history, "go").mockImplementation(() => {
      // block real navigation
    })
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Retitled report" },
    })
    fireEvent(window, new PopStateEvent("popstate"))

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    expect(goSpy).toHaveBeenCalledWith(-2)
    expect(isDialogOpen()).toBe(false)
  })
})
