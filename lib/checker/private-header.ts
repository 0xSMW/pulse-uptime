import { parsePublicHttpUrl } from "./validation"

/** Deployment-only credentials never enter monitor configuration or results. */
export function privateMonitorHeaders(
  url: URL,
  method: string
): Record<string, string> {
  const configuredUrl = process.env.PULSE_MONITOR_BYPASS_URL
  const secret = process.env.PULSE_MONITOR_BYPASS_SECRET
  if (!(configuredUrl || secret)) {
    return {}
  }

  // Reject partial configuration and unsafe header values without echoing them.
  if (!(configuredUrl && secret && /^[A-Za-z0-9_-]{32,256}$/.test(secret))) {
    throw new Error("Invalid private monitor header configuration")
  }
  let target: URL
  try {
    target = parsePublicHttpUrl(configuredUrl)
    if (target.protocol !== "https:" || target.href.includes("#")) {
      throw new Error("Invalid target")
    }
  } catch {
    // biome-ignore lint/style/useErrorCause: Configuration credentials must stay out of error chains.
    throw new Error("Invalid private monitor header configuration")
  }

  return method === "GET" && url.href === target.href
    ? { "x-pulse-monitor-key": secret }
    : {}
}
