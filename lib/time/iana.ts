/**
 * Shared IANA time zone validation. Pure and client-safe, so both server
 * services and client components import the same rule. The 64-char cap bounds
 * the string before it reaches Intl.
 */
export function isValidIanaTimeZone(value: string): boolean {
  if (!value || value.length > 64) {
    return false
  }
  try {
    // Constructing (with or without new) validates the zone and throws
    // RangeError for an unknown timeZone. The instance itself is unused.
    Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}
