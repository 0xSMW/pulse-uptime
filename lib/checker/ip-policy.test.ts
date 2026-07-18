import { describe, expect, it } from "vitest";

import { BlockedTargetError, assertPublicAddress, isPublicAddress } from "./ip-policy";

describe("public address policy", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.9",
    "192.168.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
    expect(() => assertPublicAddress(address)).toThrow(BlockedTargetError);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "allows publicly routed address %s",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );

  it("rejects malformed addresses", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("fe80::1%lo0")).toBe(false);
  });
});
