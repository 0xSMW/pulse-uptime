import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import { TeamSettings, type TeamSettingsData } from "./team-settings"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

const data: TeamSettingsData = {
  currentUserId: "usr-1",
  origin: "https://pulse.example.com",
  users: [
    {
      id: "usr-1",
      email: "stephen@example.com",
      name: "Stephen",
      role: "admin",
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-07-22T00:00:00.000Z",
    },
    {
      id: "usr-2",
      email: "dana@example.com",
      name: null,
      role: "viewer",
      createdAt: "2026-07-10T00:00:00.000Z",
      lastSeenAt: null,
    },
  ],
  invites: [
    {
      id: "inv-1",
      role: "viewer",
      createdAt: "2026-07-21T00:00:00.000Z",
      expiresAt: "2026-07-28T00:00:00.000Z",
    },
  ],
}

function markup(overrides: Partial<TeamSettingsData> = {}) {
  return renderToStaticMarkup(
    <TimezoneProvider>
      <TeamSettings data={{ ...data, ...overrides }} />
    </TimezoneProvider>
  )
}

describe("TeamSettings", () => {
  it("marks the signed-in member and offers no self mutation", () => {
    const html = markup()
    expect(html).toContain("Stephen")
    expect(html).toContain(">you</span>")
    expect(html).toContain("Signed in")
    expect(html).not.toContain('aria-label="Role for stephen@example.com"')
  })

  it("renders role controls and removal for other members", () => {
    const html = markup()
    expect(html).toContain("dana@example.com")
    expect(html).toContain('aria-label="Role for dana@example.com"')
    expect(html).toContain(">Remove</button>")
    expect(html).toContain("Never")
  })

  it("lists pending invites with revoke and the single-use note", () => {
    const html = markup()
    expect(html).toContain("Pending Invite")
    expect(html).toContain(">Revoke</button>")
    expect(html).toContain("Jul 28, 2026")
    expect(html).toContain("Links are single use and expire in 7 days")
  })

  it("renders no invite table when nothing is pending", () => {
    const html = markup({ invites: [] })
    expect(html).not.toContain("Pending Invite")
    expect(html).toContain("Create Link")
  })
})
