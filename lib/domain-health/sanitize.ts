import { DISPLAY_CONTROL_CHARS } from "@/lib/config/schema"

const MAX_DISPLAY_FACT_LENGTH = 200

/**
 * Certificate issuers and RDAP registrar names come from unauthenticated
 * remote parties (the probe deliberately skips verification), yet land in CLI
 * tables and API payloads. Same trust boundary as monitor names: control and
 * bidi characters are stripped, never stored. Empty after stripping is null.
 */
export function sanitizeDisplayFact(value: string): string | null {
  const globalPattern = new RegExp(DISPLAY_CONTROL_CHARS.source, "gu")
  const cleaned = value
    .replace(globalPattern, "")
    .trim()
    .slice(0, MAX_DISPLAY_FACT_LENGTH)
  return cleaned.length > 0 ? cleaned : null
}
