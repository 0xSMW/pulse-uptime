// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const { push, refresh } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
}))

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import {
  passwordPolicyError,
  SecuritySettings,
  type SecuritySettingsData,
} from "./security-settings"
import { SettingsDirtyProvider, useSettingsDirty } from "./settings-dirty"

// Node 22+ can leave window.localStorage undefined under jsdom without
// --localstorage-file. Provide an in-memory store for these settings tests.
beforeAll(() => {
  if (typeof window.localStorage?.getItem === "function") {
    return
  }
  const store = new Map<string, string>()
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value))
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
      clear: () => {
        store.clear()
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size
      },
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  push.mockReset()
  refresh.mockReset()
})

const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222"

const data: SecuritySettingsData = {
  sessions: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      browser: "Chrome 126",
      os: "macOS",
      ipAddress: "203.0.113.7",
      createdAt: "2026-07-18T09:00:00.000Z",
      lastSeenAt: "2026-07-18T11:59:00.000Z",
      current: true,
    },
    {
      id: OTHER_SESSION_ID,
      browser: "Safari 17",
      os: "iOS",
      ipAddress: "203.0.113.9",
      createdAt: "2026-07-15T09:00:00.000Z",
      lastSeenAt: null,
      current: false,
    },
  ],
}

function DirtyReader() {
  const context = useSettingsDirty()
  // biome-ignore lint/suspicious/noUnnecessaryConditions: useSettingsDirty returns null outside the provider
  return <span data-testid="dirty">{String(context?.dirty ?? false)}</span>
}

function renderSecurity(overrides: Partial<SecuritySettingsData> = {}) {
  return render(
    <TimezoneProvider>
      <SettingsDirtyProvider>
        <DirtyReader />
        <SecuritySettings data={{ ...data, ...overrides }} />
      </SettingsDirtyProvider>
    </TimezoneProvider>
  )
}

function fillPasswordForm(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: current },
  })
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: next },
  })
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: confirm },
  })
}

function submitButton() {
  return screen.getByRole("button", {
    name: /Change Password/,
  }) as HTMLButtonElement
}

describe("passwordPolicyError", () => {
  it("mirrors the 12-128 server policy", () => {
    expect(passwordPolicyError("short")).toBe("Use at least 12 characters")
    expect(passwordPolicyError("a".repeat(129))).toBe(
      "Use no more than 128 characters"
    )
    expect(passwordPolicyError("a".repeat(12))).toBe("")
  })
})

describe("SecuritySettings password form", () => {
  it("keeps submit disabled until every field is present and valid", () => {
    renderSecurity()
    expect(submitButton().disabled).toBe(true)
    fillPasswordForm("old-password-12", "new-password-123", "")
    expect(submitButton().disabled).toBe(true)
    fillPasswordForm("old-password-12", "new-password-123", "new-password-123")
    expect(submitButton().disabled).toBe(false)
  })

  it("shows the policy error inline for a short new password", () => {
    renderSecurity()
    fillPasswordForm("old-password-12", "short", "short")
    expect(screen.getByText("Use at least 12 characters")).toBeDefined()
    expect(submitButton().disabled).toBe(true)
  })

  it("blocks mismatched confirmation", () => {
    renderSecurity()
    fillPasswordForm("old-password-12", "new-password-123", "new-password-124")
    expect(screen.getByText("Passwords do not match")).toBeDefined()
    expect(submitButton().disabled).toBe(true)
  })

  it("marks the settings shell dirty while the form has input", () => {
    renderSecurity()
    expect(screen.getByTestId("dirty").textContent).toBe("false")
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "old" },
    })
    expect(screen.getByTestId("dirty").textContent).toBe("true")
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "" },
    })
    expect(screen.getByTestId("dirty").textContent).toBe("false")
  })

  it("posts the change and navigates to login after every session is signed out", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { changed: true, reauthenticate: true } }),
          { status: 200 }
        )
      )
    vi.stubGlobal("fetch", fetchMock)
    renderSecurity()
    fillPasswordForm("old-password-12", "new-password-123", "new-password-123")
    fireEvent.click(submitButton())
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/login")
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/me/password",
      expect.objectContaining({ method: "POST" })
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  it("keeps the form on the page when the change fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "Current password is incorrect" },
        }),
        { status: 403 }
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    renderSecurity()
    fillPasswordForm("old-password-12", "new-password-123", "new-password-123")
    fireEvent.click(submitButton())
    await waitFor(() => {
      expect(screen.getByText("Current password is incorrect")).toBeDefined()
    })
    expect(push).not.toHaveBeenCalled()
  })
})

describe("SecuritySettings sessions", () => {
  it("badges the current session instead of offering revoke", () => {
    renderSecurity()
    expect(screen.getByText("Your current session")).toBeDefined()
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1)
  })

  it("requires a second confirming click before revoking", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { revoked: true } }), {
        status: 200,
      })
    )
    vi.stubGlobal("fetch", fetchMock)
    renderSecurity()
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText("Revoke?")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => {
      expect(screen.getByText("Session signed out")).toBeDefined()
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/me/sessions/${OTHER_SESSION_ID}`,
      expect.objectContaining({ method: "DELETE" })
    )
  })

  it("cancels a pending revoke without calling the API", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderSecurity()
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByText("Revoke?")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("confirms before signing out all other sessions and reports the count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { revokedCount: 1 } }), {
        status: 200,
      })
    )
    vi.stubGlobal("fetch", fetchMock)
    renderSecurity()
    fireEvent.click(
      screen.getByRole("button", { name: "Sign Out Other Sessions" })
    )
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => {
      expect(screen.getByText("Signed out 1 other session")).toBeDefined()
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/me/sessions/revoke-others",
      expect.objectContaining({ method: "POST" })
    )
  })

  it("disables the sign-out-others action when this is the only session", () => {
    renderSecurity({
      sessions: data.sessions.filter((session) => session.current),
    })
    const button = screen.getByRole("button", {
      name: "Sign Out Other Sessions",
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})
