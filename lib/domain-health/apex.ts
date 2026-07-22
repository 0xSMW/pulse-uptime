import { getDomain } from "tldts"

/**
 * The registrable apex for a monitor hostname, the unit RDAP answers for.
 * Null for IP literals, public suffixes themselves, and anything else with no
 * registrable domain. Null means no domain lookup, never an error.
 */
export function apexDomain(hostname: string): string | null {
  return getDomain(hostname, { allowPrivateDomains: false })
}
