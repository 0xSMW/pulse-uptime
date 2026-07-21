import dns from "node:dns";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

import { BlockedTargetError, assertPublicAddress, parseIpAddress } from "./ip-policy";

export type ResolveAll = (hostname: string) => Promise<readonly LookupAddress[]>;

export const systemResolveAll: ResolveAll = (hostname) =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });

export type SecureLookup = LookupFunction;

// The connector may hand options as a bare family number or an options object.
// Both forms carry the family the caller wants (0/undefined means no preference).
function requestedFamily(lookupOptions: unknown): number {
  if (typeof lookupOptions === "number") return lookupOptions;
  if (lookupOptions !== null && typeof lookupOptions === "object" && "family" in lookupOptions) {
    const family = (lookupOptions as { family?: number }).family;
    return typeof family === "number" ? family : 0;
  }
  return 0;
}

function wantsAll(lookupOptions: unknown): boolean {
  return (
    lookupOptions !== null &&
    typeof lookupOptions === "object" &&
    "all" in lookupOptions &&
    Boolean((lookupOptions as { all?: boolean }).all)
  );
}

// Orders already-validated public addresses by the family the caller can route.
// An explicit family request wins. With no preference (family 0, which is how
// undici's connector calls it) IPv4 comes first so a runtime without IPv6 egress
// still reaches a dual-stack, IPv6-first host such as status.postmarkapp.com.
// Order within a family is preserved so a large rotating anycast pool keeps its
// resolver order for Happy-Eyeballs failover.
function orderByFamilyPreference(
  addresses: readonly LookupAddress[],
  wantFamily: number,
): LookupAddress[] {
  const primary = wantFamily === 6 ? 6 : 4;
  const preferred = addresses.filter((address) => address.family === primary);
  const rest = addresses.filter((address) => address.family !== primary);
  return [...preferred, ...rest];
}

/**
 * DNS-only secure lookup: validates every resolved address as public and
 * family-consistent, applies family ordering, and returns the validated list
 * (or single pin). Address-selection telemetry lives on the connector, not here.
 */
export function createSecureLookup(options: {
  resolveAll?: ResolveAll;
} = {}): SecureLookup {
  const resolveAll = options.resolveAll ?? systemResolveAll;

  return (hostname, lookupOptions, callback) => {
    void resolveAll(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          const error = Object.assign(new Error("Hostname did not resolve"), { code: "ENOTFOUND" });
          callback(error, "");
          return;
        }

        try {
          for (const { address, family } of addresses) {
            assertPublicAddress(address);
            const parsed = parseIpAddress(address);
            const parsedFamily = parsed?.kind() === "ipv4" ? 4 : parsed?.kind() === "ipv6" ? 6 : 0;
            if ((family !== 4 && family !== 6) || family !== parsedFamily) {
              throw new BlockedTargetError("Resolver returned an invalid address family");
            }
          }
        } catch (error) {
          callback(error as BlockedTargetError, "");
          return;
        }

        // Every address in `ordered` has already passed assertPublicAddress, so
        // the SSRF posture is identical whether we return one or all of them.
        const ordered = orderByFamilyPreference(addresses, requestedFamily(lookupOptions));
        const selected = ordered[0];
        if (wantsAll(lookupOptions)) {
          // Return the full validated list so Node's autoSelectFamily
          // (Happy-Eyeballs) can fail over past a dead anycast pool member or an
          // unroutable IPv6 address instead of being pinned to one candidate.
          callback(null, ordered.map(({ address, family }) => ({ address, family })));
        } else {
          callback(null, selected.address, selected.family);
        }
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };
}
