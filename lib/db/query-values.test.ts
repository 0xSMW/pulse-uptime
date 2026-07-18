import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { portableQueryValues } from "./query-values";

describe("portable query values", () => {
  it("serializes dates from another runtime realm before Postgres binding", () => {
    const foreignDate = runInNewContext("new Date('2026-07-18T07:00:00Z')");
    expect(foreignDate).not.toBeInstanceOf(Date);

    expect(portableQueryValues([foreignDate, "monitor-check", 90_000])).toEqual([
      "2026-07-18T07:00:00.000Z",
      "monitor-check",
      90_000,
    ]);
  });

  it("preserves binary and array parameters", () => {
    const bytes = Buffer.from([1, 2, 3]);
    const identifiers = ["one", "two"];
    const values = portableQueryValues([bytes, identifiers]);
    expect(values[0]).toBe(bytes);
    expect(values[1]).toBe(identifiers);
  });
});
