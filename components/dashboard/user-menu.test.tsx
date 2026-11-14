// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { ThemeProvider } from "@/components/dashboard/theme-provider"

import { UserMenu } from "./user-menu"

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {
        // matchMedia stub
      },
      removeEventListener: () => {
        // matchMedia stub
      },
    }),
  })
})

afterEach(cleanup)

describe("UserMenu", () => {
  it("wraps a long name and email instead of truncating", async () => {
    const name = "Maximiliana Montgomery-Fairweather Featherstonehaugh"
    const email = "operations.on.call.rotation.primary@very-long-example.com"
    render(
      <ThemeProvider>
        <UserMenu email={email} name={name} />
      </ThemeProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Account" }))
    for (const text of [name, email]) {
      const element = await screen.findByText(text)
      expect(element.className).toContain("wrap-anywhere")
      expect(element.className).not.toContain("truncate")
    }
  })

  it("renders a compact account trigger instead of the email", () => {
    const html = renderToStaticMarkup(<UserMenu email="ops@example.com" />)
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-label="Account"')
    expect(html).toContain('title="Account"')
    expect(html).toContain("lucide-user")
    expect(html).not.toContain("ops@example.com")
  })

  it("shows name initials in the trigger frame when a name is set", () => {
    const html = renderToStaticMarkup(
      <UserMenu email="ops@example.com" name="Ada Lovelace" />
    )
    expect(html).toContain("AL")
    expect(html).not.toContain("lucide-user")
  })

  it("renders the uploaded avatar in the trigger frame when set", () => {
    const html = renderToStaticMarkup(
      <UserMenu
        avatarImageId="11111111-1111-4111-8111-111111111111"
        email="ops@example.com"
      />
    )
    expect(html).toContain(
      'src="/api/v1/images/11111111-1111-4111-8111-111111111111"'
    )
    expect(html).not.toContain("lucide-user")
  })
})
