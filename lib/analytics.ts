import type { BeforeSendEvent } from "@vercel/analytics/next"

const ANALYTICS_ORIGIN = "https://analytics.invalid"

function isInvitePath(url: string): boolean {
  const { pathname } = new URL(url, ANALYTICS_ORIGIN)
  return /^\/join\/[^/]+\/?$/.test(pathname)
}

export function filterAnalyticsEvent(
  event: BeforeSendEvent
): BeforeSendEvent | null {
  if (event.type === "pageview" && isInvitePath(event.url)) {
    return null
  }

  return event
}
