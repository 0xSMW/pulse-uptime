// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { StatusMessage } from "./status-message"

afterEach(() => {
  cleanup()
})

describe("StatusMessage", () => {
  it("keeps quiet info in the focusable live region but hides it visually", () => {
    render(
      <StatusMessage
        message={{ text: "Account time zone saved", tone: "info", quiet: true }}
      />
    )
    const text = screen.getByText("Account time zone saved")
    expect(text.classList.contains("sr-only")).toBe(true)
    const region = text.parentElement!
    expect(region.getAttribute("aria-live")).toBe("polite")
    expect(region.getAttribute("tabindex")).toBe("-1")
  })

  it("shows info that is not marked quiet", () => {
    render(
      <StatusMessage
        message={{
          text: "Email updated. You will now sign in as new@example.com.",
          tone: "info",
        }}
      />
    )
    const region = screen.getByText(
      "Email updated. You will now sign in as new@example.com."
    )
    expect(region.querySelector(".sr-only")).toBeNull()
    expect(region.classList.contains("sr-only")).toBe(false)
  })

  it("shows errors even when marked quiet", () => {
    render(
      <StatusMessage
        message={{ text: "Request failed", tone: "error", quiet: true }}
      />
    )
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toBe("Request failed")
    expect(alert.querySelector(".sr-only")).toBeNull()
  })
})
