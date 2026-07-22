// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const push = vi.fn()
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/account",
  useRouter: () => ({ push, refresh: vi.fn() }),
}))

import { SettingsDirtyProvider, useDirtyGuard } from "./settings-dirty"
import { SettingsSidebar } from "./settings-sidebar"

function DirtyProbe() {
  useDirtyGuard("probe", true)
  return null
}

// jsdom does not implement HTMLDialogElement.showModal()/close() (both are
// undefined, not even throwing stubs). Polyfill the minimal behavior the
// discard-changes ConfirmDialog depends on: toggling the `open`
// attribute/property, which jsdom's generic boolean-attribute reflection
// already handles once set.
beforeEach(() => {
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
  push.mockClear()
  vi.restoreAllMocks()
})

function isDialogOpen(): boolean {
  return document.querySelector("dialog")?.open ?? false
}

describe("SettingsSidebar", () => {
  it("offers a way back to the app and links every section", () => {
    const html = renderToStaticMarkup(<SettingsSidebar />)
    expect(html).toContain("Back to app")
    expect(html).toContain('href="/settings/account"')
    expect(html).toContain('href="/settings/security"')
    expect(html).toContain('href="/settings/status-page"')
    expect(html).toContain('href="/settings/notifications"')
    expect(html).toContain('href="/settings/monitors"')
    expect(html).toContain('href="/settings/access"')
    expect(html).toContain('href="/settings/team"')
    expect(html).toContain('href="/settings/system"')
    expect(html).toContain('aria-label="Settings sections"')
  })

  it("hides every workspace surface from viewers", () => {
    const html = renderToStaticMarkup(<SettingsSidebar userRole="viewer" />)
    expect(html).toContain('href="/settings/account"')
    expect(html).toContain('href="/settings/security"')
    expect(html).not.toContain(">Workspace</span>")
    expect(html).not.toContain('href="/settings/status-page"')
    expect(html).not.toContain('href="/settings/monitors"')
    expect(html).not.toContain('href="/settings/access"')
    expect(html).not.toContain('href="/settings/team"')
    expect(html).not.toContain('href="/settings/system"')
  })

  it("groups items under Account and Workspace section labels", () => {
    const html = renderToStaticMarkup(<SettingsSidebar />)
    expect(html).toContain(">Account</span>")
    expect(html).toContain(">Workspace</span>")
    expect(html.indexOf(">Account</span>")).toBeLessThan(
      html.indexOf(">Workspace</span>")
    )
  })

  it("marks only the active section as current", () => {
    const html = renderToStaticMarkup(<SettingsSidebar />)
    const currentMatches = html.match(/aria-current="page"/g) ?? []
    expect(currentMatches).toHaveLength(1)
    expect(html).toMatch(/aria-current="page"[^>]*href="\/settings\/account"/)
  })

  it("leaves settings on Escape when nothing is dirty", () => {
    render(
      <SettingsDirtyProvider>
        <SettingsSidebar />
      </SettingsDirtyProvider>
    )
    fireEvent.keyDown(window, { key: "Escape" })
    expect(push).toHaveBeenCalledWith("/")
  })

  it("suppresses the Escape exit while a form is dirty and announces why", () => {
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
        <SettingsSidebar />
      </SettingsDirtyProvider>
    )
    expect(
      screen.queryByText("Unsaved changes — save or discard before leaving")
    ).toBeNull()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(push).not.toHaveBeenCalled()
    expect(
      screen.getByText("Unsaved changes — save or discard before leaving")
    ).toBeDefined()
  })

  it("opens the discard dialog before sidebar navigation while dirty", () => {
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
        <SettingsSidebar />
      </SettingsDirtyProvider>
    )
    const click = fireEvent.click(
      screen.getByRole("link", { name: "Monitors" })
    )
    expect(click).toBe(false)
    expect(isDialogOpen()).toBe(true)
    expect(
      screen.getByRole("heading", { name: "Discard unsaved changes?" })
    ).toBeDefined()

    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }))
    expect(isDialogOpen()).toBe(false)

    fireEvent.click(screen.getByRole("link", { name: "Back to app" }))
    expect(isDialogOpen()).toBe(true)
    expect(document.querySelectorAll("dialog[open]")).toHaveLength(1)
  })

  it("does not open the discard dialog when nothing is dirty", () => {
    render(
      <SettingsDirtyProvider>
        <SettingsSidebar />
      </SettingsDirtyProvider>
    )
    fireEvent.click(screen.getByRole("link", { name: "Monitors" }))
    expect(isDialogOpen()).toBe(false)
  })
})
