// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh, push: navigation.push }),
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
  vi.unstubAllGlobals()
  vi.clearAllMocks()
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

  it("uses the shared JSON transport for profile saves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: {} }))
    vi.stubGlobal("fetch", fetchMock)
    renderAccount()

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Renamed User  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Name" }))

    await waitFor(() => {
      expect(screen.getByText("Name saved")).toBeDefined()
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/v1/me")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(String(init.body))).toEqual({ name: "Renamed User" })
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json"
    )
    expect(navigation.refresh).toHaveBeenCalledOnce()
  })

  it("preserves the profile fallback for non-JSON errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gateway", { status: 502 }))
    )
    renderAccount()

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed User" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Name" }))

    await waitFor(() => {
      expect(screen.getByText("Request failed. Try again.")).toBeDefined()
    })
  })

  it("uploads avatar form data before saving the returned image id", async () => {
    const imageId = "11111111-1111-4111-8111-111111111111"
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { id: imageId } }, { status: 201 })
      )
      .mockResolvedValueOnce(Response.json({ data: {} }))
    vi.stubGlobal("fetch", fetchMock)
    renderAccount()

    const file = new File(["png-bytes"], "avatar.png", { type: "image/png" })
    fireEvent.change(screen.getByLabelText("Upload avatar"), {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(screen.getByText("Avatar updated")).toBeDefined()
    })
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(uploadUrl).toBe("/api/v1/images")
    expect((uploadInit.body as FormData).get("kind")).toBe("avatar")
    expect(new Headers(uploadInit.headers).get("Content-Type")).toBeNull()

    const [saveUrl, saveInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(saveUrl).toBe("/api/v1/me")
    expect(JSON.parse(String(saveInit.body))).toEqual({
      avatarImageId: imageId,
    })
    expect(navigation.refresh).toHaveBeenCalledOnce()
  })

  it("rejects an upload response without an image id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: {} }))
    vi.stubGlobal("fetch", fetchMock)
    renderAccount()

    fireEvent.change(screen.getByLabelText("Upload avatar"), {
      target: {
        files: [new File(["png-bytes"], "avatar.png", { type: "image/png" })],
      },
    })

    await waitFor(() => {
      expect(screen.getByText("Upload failed. Try again.")).toBeDefined()
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(navigation.refresh).not.toHaveBeenCalled()
  })

  it("keeps account time zone failures generic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "Internal detail" } }),
          {
            status: 500,
          }
        )
      )
    )
    renderAccount()

    fireEvent.click(screen.getByLabelText("Account time zone"))
    fireEvent.click(
      await screen.findByRole("option", { name: "Bangkok (UTC+7)" })
    )

    await waitFor(() => {
      expect(
        screen.getByText("Could not save the account time zone. Try again.")
      ).toBeDefined()
    })
    expect(screen.queryByText("Internal detail")).toBeNull()
  })
})
