// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"

import { ReportReadOnlyTimeline } from "./report-read-only-timeline"
import type { ReportUpdateData } from "./report-status"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function update(id: string, hour: number): ReportUpdateData {
  const at = `2026-07-18T${String(hour).padStart(2, "0")}:00:00.000Z`
  return {
    id,
    status: "monitoring",
    markdown: `Note ${id}`,
    publishedAt: at,
    createdAt: at,
  }
}

function page(data: ReportUpdateData[], nextCursor: string | null) {
  return new Response(
    JSON.stringify({
      apiVersion: "v1",
      kind: "StatusReportUpdateList",
      data,
      meta: { requestId: "req", nextCursor },
    }),
    { status: 200 }
  )
}

function renderTimeline(updatesNextCursor: string | null) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TimezoneProvider defaultTimezone="UTC">
        <ReportReadOnlyTimeline
          report={{
            id: "rep 1",
            updates: [update("u5", 15), update("u4", 14)],
            updatesCount: 5,
            updatesNextCursor,
          }}
        />
      </TimezoneProvider>
    </SWRConfig>
  )
}

function notes(): string[] {
  return within(screen.getByRole("list"))
    .getAllByText(/^Note /)
    .map((node) => node.textContent ?? "")
}

describe("ReportReadOnlyTimeline", () => {
  it("loads older pages newest first without duplicates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([update("u4", 14), update("u3", 13)], "c2"))
      .mockResolvedValueOnce(page([update("u2", 12), update("u1", 11)], null))
    vi.stubGlobal("fetch", fetchMock)
    renderTimeline("c1")

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText("Latest 2 of 5 updates")).toBeDefined()
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Load older" }))
    await waitFor(() =>
      expect(notes()).toEqual(["Note u5", "Note u4", "Note u3"])
    )
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/status-reports/rep%201/updates?cursor=c1&limit=50"
    )

    fireEvent.click(screen.getByRole("button", { name: "Load older" }))
    await waitFor(() =>
      expect(notes()).toEqual([
        "Note u5",
        "Note u4",
        "Note u3",
        "Note u2",
        "Note u1",
      ])
    )
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/status-reports/rep%201/updates?cursor=c2&limit=50"
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull()
  })

  it("shows the error and retries the same page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "INTERNAL", message: "Try again" } }),
          { status: 500 }
        )
      )
      .mockResolvedValueOnce(page([update("u3", 13)], null))
    vi.stubGlobal("fetch", fetchMock)
    renderTimeline("c1")

    fireEvent.click(screen.getByRole("button", { name: "Load older" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Try again")

    fireEvent.click(screen.getByRole("button", { name: "Load older" }))
    await waitFor(() =>
      expect(notes()).toEqual(["Note u5", "Note u4", "Note u3"])
    )
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/status-reports/rep%201/updates?cursor=c1&limit=50"
    )
  })

  it("hides the control when the first page is complete", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderTimeline(null)
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull()
    expect(notes()).toEqual(["Note u5", "Note u4"])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
