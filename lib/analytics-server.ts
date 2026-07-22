import { track } from "@vercel/analytics/server"

/**
 * Product analytics event names as they appear in the Vercel dashboard.
 * Title Case with spaces, object first so related events sort together.
 */
type AnalyticsEventName =
  | "Monitor Created"
  | "Monitor Deleted"
  | "Dependency Installed"
  | "Status Page Customized"
  | "Invite Created"
  | "Member Joined"
  | "Report Created"
  | "Incident Promoted"
  | "CLI Authorized"
  | "Token Created"

export type AnalyticsSource = "web" | "cli" | "api"

/**
 * Every event property must stay low cardinality: enums and booleans only,
 * never URLs, emails, names, or other user-entered values.
 */
type AnalyticsProps = Record<string, AnalyticsSource | string | boolean>

/**
 * The principal key is `${principal.type}:${principal.id}` (see
 * lib/api/middleware.ts), so the prefix identifies the surface the
 * request came from.
 */
export function sourceFromPrincipalKey(principalKey: string): AnalyticsSource {
  if (principalKey.startsWith("cli_session:")) {
    return "cli"
  }
  if (principalKey.startsWith("api_token:")) {
    return "api"
  }
  return "web"
}

/**
 * Fire and forget. A failed or unavailable analytics beacon must never
 * fail the mutation that emitted it, so rejections are swallowed.
 */
export function trackEvent(
  name: AnalyticsEventName,
  props?: AnalyticsProps
): void {
  track(name, props).catch(() => {
    // Intentionally ignored.
  })
}
