// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
} from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

import { NotificationsSettings } from "./notifications-settings"

function render(sender: string | null) {
  return renderToStaticMarkup(
    <NotificationsSettings
      data={{ defaultRecipients: ["ops@example.com"], sender }}
    />
  )
}

describe("NotificationsSettings", () => {
  it("renders the recipients form with save and test actions", () => {
    const html = render("Pulse <alerts@example.com>")
    expect(html).toContain("Default Recipients")
    expect(html).toContain("ops@example.com")
    expect(html).toContain("Save Recipients")
    expect(html).toContain("Send Test Email")
    expect(html).toContain("via Resend")
  })

  it("states when no sender is configured", () => {
    const html = render(null)
    expect(html).toContain("Email sender is not configured")
  })

  it("holds only notification content — appearance moved to Account", () => {
    const html = render(null)
    expect(html).not.toContain("Appearance")
    expect(html).not.toContain("Time zone")
  })
})

describe("NotificationsSettings save feedback", () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function stubConfig(operationState: "accepted" | "failed") {
    vi.stubGlobal("crypto", {
      randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/v1/config") {
          return Promise.resolve(
            Response.json({
              data: {
                version: 1,
                settings: { defaultRecipients: [] },
                monitors: [],
              },
              meta: { configHash: "hash-1" },
            })
          )
        }
        if (url === "/api/v1/config/plan") {
          return Promise.resolve(
            Response.json({
              data: {
                baseConfigHash: "hash-1",
                targetConfigHash: "hash-2",
                planHash: "plan-1",
                destructiveConsentRequired: false,
              },
            })
          )
        }
        if (url === "/api/v1/config/apply") {
          return Promise.resolve(
            Response.json({
              data: { id: "op-1", state: "written", rejectionReason: null },
            })
          )
        }
        return Promise.resolve(
          Response.json({
            data: {
              id: "op-1",
              state: operationState,
              rejectionReason: null,
            },
          })
        )
      })
    )
  }

  async function save() {
    vi.useFakeTimers()
    renderDom(
      <NotificationsSettings
        data={{ defaultRecipients: ["ops@example.com"], sender: null }}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save Recipients" }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
  }

  it("announces saved recipients to screen readers only", async () => {
    stubConfig("accepted")
    await save()
    const status = screen.getByText("Recipients saved")
    expect(status.getAttribute("aria-live")).toBe("polite")
    expect(status.classList.contains("sr-only")).toBe(true)
  })

  it("keeps a failed save visible", async () => {
    stubConfig("failed")
    await save()
    const status = screen.getByText(
      "Configuration update failed. Reload and try again."
    )
    expect(status.classList.contains("sr-only")).toBe(false)
    expect(status.className).toContain("text-[var(--down-text)]")
  })
})
