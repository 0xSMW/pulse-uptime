import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi } from "vitest";

import { BlockedTargetError } from "./ip-policy";
import { createSecureLookup } from "./secure-lookup";

function runLookup(addresses: readonly LookupAddress[], all = false) {
  const onAddressSelected = vi.fn();
  const lookup = createSecureLookup({ resolveAll: async () => addresses, onAddressSelected });
  return new Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }>(
    (resolve) => lookup("example.com", { all }, (error, address, family) =>
      resolve({ error, address, family })),
  ).then((result) => ({ ...result, onAddressSelected }));
}

describe("secure connection lookup", () => {
  it("returns one exact validated address and records it", async () => {
    const addresses = [
      { address: "2001:4860:4860::8888", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ];
    const result = await runLookup(addresses);
    expect(result.error).toBeNull();
    expect(result.address).toBe(addresses[0].address);
    expect(result.family).toBe(6);
    expect(result.onAddressSelected).toHaveBeenCalledWith(addresses[0]);
  });

  it("rejects all answers when one answer is private", async () => {
    const result = await runLookup([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(result.error).toBeInstanceOf(BlockedTargetError);
    expect(result.onAddressSelected).not.toHaveBeenCalled();
  });

  it("supports Node's all-address callback shape while pinning one address", async () => {
    const result = await runLookup([{ address: "8.8.4.4", family: 4 }], true);
    expect(result.address).toEqual([{ address: "8.8.4.4", family: 4 }]);
  });

  it("returns ENOTFOUND for an empty answer", async () => {
    const result = await runLookup([]);
    expect(result.error?.code).toBe("ENOTFOUND");
  });

  it("rejects a mismatched resolver address family", async () => {
    const result = await runLookup([{ address: "8.8.8.8", family: 6 }]);
    expect(result.error).toBeInstanceOf(BlockedTargetError);
  });

  it("preserves resolver errors", async () => {
    const resolverError = Object.assign(new Error("dns unavailable"), { code: "EAI_AGAIN" });
    const lookup = createSecureLookup({ resolveAll: async () => { throw resolverError; } });
    const result = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookup("example.com", {}, (error) => resolve(error)),
    );
    expect(result).toBe(resolverError);
  });
});
