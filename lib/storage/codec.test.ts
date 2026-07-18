import { describe, expect, it } from "vitest";

import { decodeTelemetry, encodeTelemetry, PACKED_TELEMETRY_VERSION, type TelemetryValue } from "./codec";

describe("packed telemetry codec", () => {
  it.each([0, 1, 100])("round trips %i monitor values deterministically", (count) => {
    const values: TelemetryValue[] = Array.from({ length: count }, (_, index) => ({
      expected: index % 5 !== 0,
      completed: index % 5 !== 0 && index % 4 !== 0,
      failed: index % 5 !== 0 && index % 4 !== 0 && index % 3 === 0,
      latencyMs: index % 5 === 0 || index % 4 === 0 ? null : index * 137,
    }));
    const first = encodeTelemetry(values);
    const second = encodeTelemetry(values);
    expect(first).toEqual(second);
    expect(decodeTelemetry(first)).toEqual(values);
    if (count === 100) {
      expect(first.expectedBitmap.length + first.completedBitmap.length + first.failureBitmap.length + first.latencyValues.length)
        .toBeLessThanOrEqual(1_024);
    }
  });

  it("rejects unknown versions independently of the payload", () => {
    const packed = encodeTelemetry([]);
    expect(() => decodeTelemetry({ ...packed, encodingVersion: PACKED_TELEMETRY_VERSION + 1 }))
      .toThrow("Unsupported packed telemetry version");
  });

  it("round trips partial completion and large integer latencies", () => {
    const values: TelemetryValue[] = [
      { expected: true, completed: true, failed: false, latencyMs: 0 },
      { expected: true, completed: false, failed: false, latencyMs: null },
      { expected: true, completed: true, failed: true, latencyMs: 120_000 },
    ];
    expect(decodeTelemetry(encodeTelemetry(values))).toEqual(values);
  });
});
