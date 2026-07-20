import { describe, expect, it, vi } from "vitest";

import { decodeTelemetry } from "./codec";
import { writePackedMinute, WRITE_PACKED_MINUTE_SQL } from "./batch";

describe("packed minute writer", () => {
  it("uses one no-returning request and records incomplete checks as gaps", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await writePackedMinute({ query }, {
      scheduledMinute: new Date("2026-07-18T03:15:00Z"),
      configVersion: 4,
      monitorIds: ["b", "a"],
      expectedMonitorIds: ["b", "a"],
      results: [{ monitorId: "b", completed: true, failed: false, latencyMs: 42 }],
      schedulerStartedAt: new Date("2026-07-18T03:15:01Z"),
      schedulerCompletedAt: new Date("2026-07-18T03:15:04Z"),
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(WRITE_PACKED_MINUTE_SQL.trim().toLowerCase()).not.toMatch(/returning\s+\w+\s*$/);
    const values = query.mock.calls[0]![1];
    expect(values[3]).toEqual(["a", "b"]);
    expect(decodeTelemetry({
      encodingVersion: values[1] as number,
      monitorCount: 2,
      expectedBitmap: values[4] as Buffer,
      completedBitmap: values[5] as Buffer,
      failureBitmap: values[6] as Buffer,
      latencyValues: values[7] as Buffer,
    })).toEqual([
      { expected: true, completed: false, failed: false, latencyMs: null },
      { expected: true, completed: true, failed: false, latencyMs: 42 },
    ]);
    expect(typeof values[10]).toBe("string");
    expect(JSON.parse(values[10] as string)).toMatchObject([
      { monitorId: "a", eventType: "scheduler_gap", errorCode: "SCHEDULED_CHECK_MISSING" },
    ]);
  });

  it("upserts identical failures without losing aggregate fields", () => {
    expect(WRITE_PACKED_MINUTE_SQL).toContain("jsonb_to_recordset($11::text::jsonb)");
    expect(WRITE_PACKED_MINUTE_SQL).toContain("occurrence_count = monitor_exceptions.occurrence_count + 1");
    expect(WRITE_PACKED_MINUTE_SQL).toContain("worst_latency_ms = greatest");
    expect(WRITE_PACKED_MINUTE_SQL).toContain("first_seen_at = least");
    expect(WRITE_PACKED_MINUTE_SQL).toContain("last_seen_at = greatest");
    expect(WRITE_PACKED_MINUTE_SQL).toContain("from exception_rows cross join batch_insert");
  });
});
