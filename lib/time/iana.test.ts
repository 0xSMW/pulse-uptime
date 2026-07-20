import { describe, expect, it } from "vitest";

import { isValidIanaTimeZone } from "./iana";

describe("isValidIanaTimeZone", () => {
  it("accepts real IANA zone names", () => {
    expect(isValidIanaTimeZone("Asia/Bangkok")).toBe(true);
    expect(isValidIanaTimeZone("UTC")).toBe(true);
    expect(isValidIanaTimeZone("America/New_York")).toBe(true);
  });

  it("rejects unknown zones and the empty string", () => {
    expect(isValidIanaTimeZone("Not/AZone")).toBe(false);
    expect(isValidIanaTimeZone("")).toBe(false);
  });

  it("rejects the system sentinel", () => {
    expect(isValidIanaTimeZone("system")).toBe(false);
  });

  it("rejects values over the 64-char cap before hitting Intl", () => {
    expect(isValidIanaTimeZone("A".repeat(65))).toBe(false);
  });
});
