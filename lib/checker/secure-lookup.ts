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

export function createSecureLookup(options: {
  resolveAll?: ResolveAll;
  onAddressSelected?: (address: LookupAddress) => void;
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

        const selected = addresses[0];
        options.onAddressSelected?.(selected);
        if ("all" in lookupOptions && lookupOptions.all) {
          callback(null, [selected]);
        } else {
          callback(null, selected.address, selected.family);
        }
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };
}
