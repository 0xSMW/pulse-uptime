import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor, pageLimit } from "./pagination";

describe("API pagination", () => {
  it("round-trips opaque cursor tuples", () => {
    const cursor = encodeCursor({ sort: "2026-07-18T00:00:00.000Z", id: "item_1" });
    expect(cursor).not.toContain("2026-");
    expect(decodeCursor(cursor)).toEqual({ sort: "2026-07-18T00:00:00.000Z", id: "item_1" });
  });

  it("rejects malformed cursors and limits", () => {
    expect(decodeCursor("not-json")).toBeNull();
    expect(pageLimit(null)).toBe(50);
    expect(pageLimit("1")).toBe(1);
    expect(pageLimit("100")).toBe(100);
    expect(pageLimit("0")).toBeNull();
    expect(pageLimit("101")).toBeNull();
    expect(pageLimit("1.5")).toBeNull();
  });
});
