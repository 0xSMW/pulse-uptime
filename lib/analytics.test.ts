import { describe, expect, it } from "vitest"

import { filterAnalyticsEvent } from "./analytics"

describe("filterAnalyticsEvent", () => {
  it.each([
    "/join/invite-token",
    "/join/invite-token?source=email",
    "https://pulse.example/join/invite-token",
    "https://pulse.example/join/invite-token/",
  ])("drops the page view for an invite URL: %s", (url) => {
    expect(filterAnalyticsEvent({ type: "pageview", url })).toBeNull()
  })

  it.each([
    { type: "pageview" as const, url: "/" },
    { type: "pageview" as const, url: "/join" },
    { type: "pageview" as const, url: "/join/invite-token/extra" },
    { type: "event" as const, url: "/join/invite-token" },
  ])("keeps analytics that do not expose an invite page view", (event) => {
    expect(filterAnalyticsEvent(event)).toBe(event)
  })
})
