import { describe, expect, it } from "vitest";

import { deleteFixtureMarker, resetFixture, seedFixture } from "../src/fixtures";
import type { GatedConnection } from "../src/db-connection";

interface LogEntry {
  type: "unsafe" | "delete-marker" | "insert-marker" | "delete" | "insert";
  table?: unknown;
  rowCount?: number;
}

function fakeConn(): { conn: GatedConnection; log: LogEntry[] } {
  const log: LogEntry[] = [];

  const db = {
    delete(table: unknown) {
      return {
        where() {
          log.push({ type: "delete", table });
          return Promise.resolve();
        },
      };
    },
    insert(table: unknown) {
      return {
        values(rows: unknown) {
          const rowArray = Array.isArray(rows) ? rows : [rows];
          log.push({ type: "insert", table, rowCount: rowArray.length });
          return Promise.resolve();
        },
      };
    },
  };

  // Mirrors the sql client's dual calling convention used in fixtures.ts:
  // tagged-template calls for the marker delete/insert, `.unsafe(...)` for
  // the marker table's create-if-not-exists statement.
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes('delete from "_query_perf_fixture"')) {
      log.push({ type: "delete-marker" });
    } else if (text.includes('insert into "_query_perf_fixture"')) {
      log.push({ type: "insert-marker" });
    }
    return Promise.resolve([]);
  }) as unknown as GatedConnection["sql"];
  (sql as unknown as { unsafe: (text: string) => Promise<unknown[]> }).unsafe = () => {
    log.push({ type: "unsafe" });
    return Promise.resolve([]);
  };

  return {
    conn: { db, sql, project: { projectId: "fake-project", regionId: "fake-region", database: "fake" } } as unknown as GatedConnection,
    log,
  };
}

describe("deleteFixtureMarker", () => {
  it("issues a delete against the marker table for the qh-fixture tag", async () => {
    const { conn, log } = fakeConn();
    await deleteFixtureMarker(conn);
    expect(log).toEqual([{ type: "delete-marker" }]);
  });
});

describe("seedFixture marker invalidation sequencing", () => {
  it("invalidates the marker before any fixture table is reset, and re-inserts it only after every seed write completes", async () => {
    const { conn, log } = fakeConn();
    await seedFixture(conn);

    const deleteMarkerIndex = log.findIndex((entry) => entry.type === "delete-marker");
    const firstResetDeleteIndex = log.findIndex((entry) => entry.type === "delete");
    const firstInsertIndex = log.findIndex((entry) => entry.type === "insert");
    const insertMarkerIndex = log.findIndex((entry) => entry.type === "insert-marker");

    expect(deleteMarkerIndex).toBeGreaterThanOrEqual(0);
    expect(insertMarkerIndex).toBeGreaterThanOrEqual(0);
    // The marker must be gone before resetFixtureData deletes a single
    // fixture-owned row, and before the first replacement row is written --
    // otherwise a crash mid-reseed leaves a marker that still claims the old
    // (now partially-deleted or partially-rewritten) cardinalities are valid.
    expect(deleteMarkerIndex).toBeLessThan(firstResetDeleteIndex);
    expect(deleteMarkerIndex).toBeLessThan(firstInsertIndex);
    // The marker can only reappear as the very last thing seedFixture does,
    // once every seed insert above it in the log has already succeeded.
    expect(insertMarkerIndex).toBe(log.length - 1);
  });
});

describe("resetFixture marker invalidation sequencing", () => {
  it("invalidates the marker before deleting any fixture-tagged row", async () => {
    const { conn, log } = fakeConn();
    await resetFixture(conn);

    const deleteMarkerIndex = log.findIndex((entry) => entry.type === "delete-marker");
    const firstResetDeleteIndex = log.findIndex((entry) => entry.type === "delete");

    expect(deleteMarkerIndex).toBeGreaterThanOrEqual(0);
    expect(deleteMarkerIndex).toBeLessThan(firstResetDeleteIndex);
    // resetFixture never re-inserts the marker.
    expect(log.some((entry) => entry.type === "insert-marker")).toBe(false);
  });
});
