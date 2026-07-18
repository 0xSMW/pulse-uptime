export const PACKED_TELEMETRY_VERSION = 1;

export type PackedTelemetry = {
  encodingVersion: number;
  monitorCount: number;
  expectedBitmap: Buffer;
  completedBitmap: Buffer;
  failureBitmap: Buffer;
  latencyValues: Buffer;
};

export type TelemetryValue = {
  expected: boolean;
  completed: boolean;
  failed: boolean;
  latencyMs: number | null;
};

function encodeBitmap(values: readonly boolean[]): Buffer {
  const packed = Buffer.alloc(Math.ceil(values.length / 8));
  values.forEach((value, index) => {
    if (value) packed[index >> 3] |= 1 << (index & 7);
  });
  return packed;
}

function readBit(buffer: Buffer, index: number): boolean {
  return (buffer[index >> 3]! & (1 << (index & 7))) !== 0;
}

export function encodeTelemetry(values: readonly TelemetryValue[]): PackedTelemetry {
  const latencies = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => {
    if (value.completed && !value.expected) throw new Error("An unexpected check cannot complete");
    if (value.failed && !value.completed) throw new Error("An incomplete check cannot fail");
    if (value.completed && value.latencyMs === null) throw new Error("A completed check requires latency");
    if (value.latencyMs !== null && (!Number.isSafeInteger(value.latencyMs) || value.latencyMs < 0 || value.latencyMs >= 0xffffffff)) {
      throw new RangeError("Latency must be a nonnegative 32-bit integer");
    }
    latencies.writeUInt32BE(value.latencyMs ?? 0xffffffff, index * 4);
  });
  return {
    encodingVersion: PACKED_TELEMETRY_VERSION,
    monitorCount: values.length,
    expectedBitmap: encodeBitmap(values.map((value) => value.expected)),
    completedBitmap: encodeBitmap(values.map((value) => value.completed)),
    failureBitmap: encodeBitmap(values.map((value) => value.failed)),
    latencyValues: latencies,
  };
}

export function decodeTelemetry(packed: PackedTelemetry): TelemetryValue[] {
  if (packed.encodingVersion !== PACKED_TELEMETRY_VERSION) {
    throw new Error(`Unsupported packed telemetry version: ${packed.encodingVersion}`);
  }
  const bitmapBytes = Math.ceil(packed.monitorCount / 8);
  if ([packed.expectedBitmap, packed.completedBitmap, packed.failureBitmap]
    .some((bitmap) => bitmap.length !== bitmapBytes)) throw new Error("Invalid packed bitmap length");
  const result: TelemetryValue[] = [];
  if (packed.latencyValues.length !== packed.monitorCount * 4) throw new Error("Invalid packed latency length");
  for (let index = 0; index < packed.monitorCount; index += 1) {
    const encodedLatency = packed.latencyValues.readUInt32BE(index * 4);
    const completed = readBit(packed.completedBitmap, index);
    const failed = readBit(packed.failureBitmap, index);
    const expected = readBit(packed.expectedBitmap, index);
    if (failed && !completed) throw new Error("Invalid failure bitmap");
    if (completed && !expected) throw new Error("Invalid completed bitmap");
    if (completed === (encodedLatency === 0xffffffff)) throw new Error("Invalid packed latency completion marker");
    result.push({
      expected,
      completed,
      failed,
      latencyMs: encodedLatency === 0xffffffff ? null : encodedLatency,
    });
  }
  return result;
}
