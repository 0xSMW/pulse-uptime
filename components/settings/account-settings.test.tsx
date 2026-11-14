// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

import { ThemeProvider } from "@/components/dashboard/theme-provider"
import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import {
  AccountSettings,
  type AccountSettingsData,
  initialsFor,
} from "./account-settings"
import { SettingsDirtyProvider, useSettingsDirty } from "./settings-dirty"

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {
        // matchMedia stub
      },
      removeEventListener: () => {
        // matchMedia stub
      },
      addListener: () => {
        // matchMedia stub
      },
      removeListener: () => {
        // matchMedia stub
      },
      dispatchEvent: () => false,
    }),
  })
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function DirtyReader() {
  const context = useSettingsDirty()
  // biome-ignore lint/suspicious/noUnnecessaryConditions: useSettingsDirty returns null outside the provider
  return <span data-testid="dirty">{String(context?.dirty ?? false)}</span>
}

function renderAccount(
  data: AccountSettingsData = {
    name: "Test User",
    email: "user@example.com",
    timezone: null,
    avatarImageId: null,
  }
) {
  return render(
    <ThemeProvider>
      <TimezoneProvider>
        <SettingsDirtyProvider>
          <DirtyReader />
          <AccountSettings data={data} />
        </SettingsDirtyProvider>
      </TimezoneProvider>
    </ThemeProvider>
  )
}

describe("initialsFor", () => {
  it("derives initials from the name, falling back to the email", () => {
    expect(initialsFor("Test User", "user@example.com")).toBe("TU")
    expect(initialsFor("Test", "user@example.com")).toBe("T")
    expect(initialsFor(null, "user@example.com")).toBe("U")
    expect(initialsFor("  ", "ops@example.com")).toBe("O")
  })
})

describe("AccountSettings", () => {
  it("renders profile fields with the avatar upload control", () => {
    renderAccount()
    expect(screen.getByText("user@example.com")).toBeDefined()
    expect(screen.getByRole("button", { name: "Upload Avatar" })).toBeDefined()
    expect(screen.getByLabelText("Upload avatar")).toBeDefined()
    expect(screen.getByLabelText("Name")).toBeDefined()
    expect(screen.getByRole("button", { name: "Change Email" })).toBeDefined()
  })

  it("renders the stored avatar from the authenticated image route", () => {
    const { container } = renderAccount({
      name: "Test User",
      email: "user@example.com",
      timezone: null,
      avatarImageId: "11111111-1111-4111-8111-111111111111",
    })
    const avatar = container.querySelector("img")
    expect(avatar?.getAttribute("src")).toBe(
      "/api/v1/images/11111111-1111-4111-8111-111111111111"
    )
  })

  it("renders theme and time-zone preferences with per-scope descriptions", () => {
    renderAccount()
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeDefined()
    expect(screen.getByText(/on this device only/)).toBeDefined()
    expect(screen.getByText(/Saved to your account/)).toBeDefined()
    expect(screen.getByLabelText("Account time zone")).toBeDefined()
    expect(
      screen.getByText("Use a different time zone on this device")
    ).toBeDefined()
  })

  it("blocks the email change while the confirmation does not match", () => {
    renderAccount()
    fireEvent.click(screen.getByRole("button", { name: "Change Email" }))
    fireEvent.change(screen.getByLabelText("New email"), {
      target: { value: "new@example.com" },
    })
    fireEvent.change(screen.getByLabelText("Confirm new email"), {
      target: { value: "other@example.com" },
    })
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "correct horse" },
    })
    expect(screen.getByText("Email addresses do not match")).toBeDefined()
    const submit = screen.getByRole("button", {
      name: "Change Email",
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  it("marks the settings shell dirty when the name is edited", () => {
    renderAccount()
    expect(screen.getByTestId("dirty").textContent).toBe("false")
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Someone Else" },
    })
    expect(screen.getByTestId("dirty").textContent).toBe("true")
  })

  it("announces a saved name to screen readers only", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})))
    renderAccount()
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Someone Else" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save Name" }))
    })
    const saved = screen.getByText("Name saved")
    expect(saved.classList.contains("sr-only")).toBe(true)
    expect(saved.parentElement?.getAttribute("aria-live")).toBe("polite")
    vi.unstubAllGlobals()
  })

  it("keeps the new sign-in email visible after an email change", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ data: { email: "new@example.com" } })
        )
    )
    renderAccount()
    fireEvent.click(screen.getByRole("button", { name: "Change Email" }))
    fireEvent.change(screen.getByLabelText("New email"), {
      target: { value: "new@example.com" },
    })
    fireEvent.change(screen.getByLabelText("Confirm new email"), {
      target: { value: "new@example.com" },
    })
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "correct horse" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Change Email" }))
    })
    const message = screen.getByText(
      "Email updated. You will now sign in as new@example.com."
    )
    expect(message.classList.contains("sr-only")).toBe(false)
    expect(message.querySelector(".sr-only")).toBeNull()
    vi.unstubAllGlobals()
  })

  it("marks the settings shell dirty while the email form has input", () => {
    renderAccount()
    fireEvent.click(screen.getByRole("button", { name: "Change Email" }))
    expect(screen.getByTestId("dirty").textContent).toBe("false")
    fireEvent.change(screen.getByLabelText("New email"), {
      target: { value: "new@example.com" },
    })
    expect(screen.getByTestId("dirty").textContent).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByTestId("dirty").textContent).toBe("false")
  })
})
