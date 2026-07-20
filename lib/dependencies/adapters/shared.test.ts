import { describe, expect, it } from "vitest";

import { toBoundedPlainText } from "./shared";

const MAX_BODY_BYTES = 4096;

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("toBoundedPlainText byte capping", () => {
  it("returns short strings unchanged", () => {
    expect(toBoundedPlainText("a short incident note")).toBe("a short incident note");
  });

  it("caps a hundreds of KB ASCII body within the byte limit and fast", () => {
    const huge = "a".repeat(500_000);
    const start = performance.now();
    const result = toBoundedPlainText(huge);
    const elapsed = performance.now() - start;
    expect(utf8Length(result)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(utf8Length(result)).toBe(MAX_BODY_BYTES);
    // The old O(n^2) implementation took tens of seconds on an input this size.
    // A generous bound still catches any regression to per character encoding.
    expect(elapsed).toBeLessThan(1000);
  });

  it("caps a hundreds of KB multibyte body on a code point boundary", () => {
    // The euro sign is three UTF-8 bytes, so the cap of 4096 lands mid character
    // and forces the back off to the nearest boundary.
    const huge = "€".repeat(200_000);
    const start = performance.now();
    const result = toBoundedPlainText(huge);
    const elapsed = performance.now() - start;
    expect(utf8Length(result)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    // 4096 / 3 = 1365 whole characters, so 4095 bytes with no split sequence.
    expect(utf8Length(result)).toBe(4095);
    // Round tripping proves the result is valid UTF-8 with no dangling bytes.
    expect(utf8Length(new TextDecoder().decode(new TextEncoder().encode(result)))).toBe(4095);
    expect(result.endsWith("€")).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it("never splits a surrogate pair when capping emoji", () => {
    const huge = "\u{1F600}".repeat(200_000);
    const result = toBoundedPlainText(huge);
    expect(utf8Length(result)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    // Each emoji is four UTF-8 bytes, so a clean cut keeps 1024 of them intact.
    expect([...result]).toHaveLength(1024);
    expect(result.endsWith("\u{1F600}")).toBe(true);
  });
});
