const RETURN_TO_ORIGIN = "https://pulse.invalid"

export function safeReturnTo(value: unknown, fallback = "/"): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return fallback
  }

  try {
    const target = new URL(value, RETURN_TO_ORIGIN)
    if (target.origin !== RETURN_TO_ORIGIN) {
      return fallback
    }
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return fallback
  }
}
