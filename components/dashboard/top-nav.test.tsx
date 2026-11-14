// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

let pathname = "/"
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

import { TopNav } from "./top-nav"

afterEach(() => {
  cleanup()
  pathname = "/"
})

function renderNav() {
  render(<TopNav email="ops@example.com" name="Ops Team" />)
  return within(screen.getByRole("navigation", { name: "Primary navigation" }))
}

describe("TopNav", () => {
  it("keeps brand, primary links, then account in focus order", () => {
    renderNav()
    const nav = screen.getByRole("navigation", { name: "Primary navigation" })
    const focusable = Array.from(nav.querySelectorAll("a[href], button")).map(
      (element) =>
        element.getAttribute("aria-label") ?? element.textContent?.trim()
    )

    expect(focusable).toEqual([
      "Pulse",
      "Overview",
      "Incidents",
      "Status Page",
      "Account",
    ])
  })

  it("marks Overview current on monitor pages", () => {
    pathname = "/monitors/abc"
    const nav = renderNav()

    expect(
      nav.getByRole("link", { name: "Overview" }).getAttribute("aria-current")
    ).toBe("page")
    expect(
      nav.getByRole("link", { name: "Incidents" }).hasAttribute("aria-current")
    ).toBe(false)
  })

  it("marks Incidents current on incident pages", () => {
    pathname = "/incidents/reports/r1"
    const nav = renderNav()

    expect(
      nav.getByRole("link", { name: "Incidents" }).getAttribute("aria-current")
    ).toBe("page")
    expect(
      nav.getByRole("link", { name: "Overview" }).hasAttribute("aria-current")
    ).toBe(false)
  })

  it("opens the public status page in a new tab without a referrer", () => {
    const status = renderNav().getByRole("link", { name: "Status Page" })

    expect(status.getAttribute("href")).toBe("/status")
    expect(status.getAttribute("target")).toBe("_blank")
    expect(status.getAttribute("rel")).toBe("noreferrer")
    expect(status.hasAttribute("aria-current")).toBe(false)
  })
})
