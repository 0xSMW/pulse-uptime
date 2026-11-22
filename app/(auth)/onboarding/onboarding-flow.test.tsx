// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"

import { OnboardingFlow } from "./onboarding-flow"

const setupToken = "operator-setup-token-1234567890"

async function renderAccountStep() {
  render(
    <TimezoneProvider>
      <OnboardingFlow initialStep="readiness" />
    </TimezoneProvider>
  )
  expect(globalThis.fetch).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText("Setup Token"), {
    target: { value: setupToken },
  })
  fireEvent.click(screen.getByRole("button", { name: "Check Readiness" }))
  await waitFor(
    () => {
      expect(
        screen.getByRole("button", { name: "Continue to Account" })
      ).not.toHaveProperty("disabled", true)
    },
    { timeout: 2000 }
  )
  fireEvent.click(screen.getByRole("button", { name: "Continue to Account" }))
  await screen.findByRole("heading", { name: "Create your admin account" })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("onboarding account step", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (path) =>
      path === "/api/onboarding/readiness"
        ? new Response(
            JSON.stringify({
              canContinue: true,
              checks: [
                { system: "vercel", state: "ready" },
                { system: "database", state: "ready" },
                { system: "edge", state: "ready" },
                { system: "email", state: "ready" },
              ],
            }),
            { status: 200 }
          )
        : new Response(JSON.stringify({ nextStep: "monitor" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
    )
  })

  it("proves the setup token before readiness and reuses it for account creation", async () => {
    await renderAccountStep()
    const readinessCall = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([path]) => path === "/api/onboarding/readiness")
    expect(readinessCall).toBeDefined()
    expect(
      new Headers(readinessCall![1]?.headers).get("x-pulse-bootstrap-token")
    ).toBe(setupToken)
    expect(screen.queryByLabelText("Setup Token")).toBeNull()
  })

  it("keeps a rejected setup token on the readiness step", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "A valid setup token is required" }),
        {
          status: 403,
        }
      )
    )
    render(
      <TimezoneProvider>
        <OnboardingFlow initialStep="readiness" />
      </TimezoneProvider>
    )
    fireEvent.change(screen.getByLabelText("Setup Token"), {
      target: { value: "incorrect-token" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Check Readiness" }))

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Setup token is invalid"
    )
    expect(
      screen.getByRole("button", { name: "Continue to Account" })
    ).toHaveProperty("disabled", true)
    expect(
      screen.queryByRole("heading", { name: "Create your admin account" })
    ).toBeNull()
  })

  it("rechecks readiness with the admin session after account creation", async () => {
    render(
      <TimezoneProvider>
        <OnboardingFlow initialStep="monitor" />
      </TimezoneProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Back" }))

    await waitFor(() => {
      const readinessCall = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([path]) => path === "/api/onboarding/readiness")
      expect(readinessCall).toBeDefined()
      expect(
        new Headers(readinessCall![1]?.headers).has("x-pulse-bootstrap-token")
      ).toBe(false)
    })
    expect(screen.queryByLabelText("Setup Token")).toBeNull()
  })

  it("shows an optional name field above the email field", async () => {
    await renderAccountStep()
    const name = screen.getByLabelText("Name") as HTMLInputElement
    expect(name).toBeDefined()
    expect(name.required).toBe(false)
    expect(name.maxLength).toBe(120)
    // The name field comes before email in document order.
    const email = screen.getByLabelText("Email")
    expect(
      name.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("submits the trimmed name with the account payload", async () => {
    await renderAccountStep()
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Ada Lovelace  " },
    })
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse-battery" },
    })
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "correct-horse-battery" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }))

    await waitFor(() => {
      const accountCall = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([path]) => path === "/api/onboarding/account")
      expect(accountCall).toBeDefined()
      const body = JSON.parse(String((accountCall![1] as RequestInit).body))
      expect(body.name).toBe("Ada Lovelace")
      expect(body.email).toBe("admin@example.com")
      expect(body.bootstrapToken).toBe(setupToken)
    })
  })

  it("omits the name when the field is left blank", async () => {
    await renderAccountStep()
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse-battery" },
    })
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "correct-horse-battery" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }))

    await waitFor(() => {
      const accountCall = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([path]) => path === "/api/onboarding/account")
      expect(accountCall).toBeDefined()
      const body = JSON.parse(String((accountCall![1] as RequestInit).body))
      expect(body.name).toBeUndefined()
    })
  })
})
