export const HISTOGRAM_VERSION = 1
export const LATENCY_BUCKET_UPPER_BOUNDS_MS = [
  100, 250, 500, 1000, 2500, 5000, 10_000,
] as const
export const HISTOGRAM_BUCKET_COUNT = LATENCY_BUCKET_UPPER_BOUNDS_MS.length + 1

export function latencyBucket(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new RangeError("Latency must be nonnegative")
  }
  const index = LATENCY_BUCKET_UPPER_BOUNDS_MS.findIndex(
    (upper) => latencyMs <= upper
  )
  return index < 0 ? HISTOGRAM_BUCKET_COUNT - 1 : index
}

export function histogramFor(values: readonly number[]): number[] {
  const histogram = new Array(HISTOGRAM_BUCKET_COUNT).fill(0)
  for (const value of values) {
    histogram[latencyBucket(value)] += 1
  }
  return histogram
}

export function mergeHistograms(
  histograms: readonly (readonly number[])[]
): number[] {
  const merged = new Array(HISTOGRAM_BUCKET_COUNT).fill(0)
  for (const histogram of histograms) {
    if (histogram.length !== HISTOGRAM_BUCKET_COUNT) {
      throw new Error("Histogram version mismatch")
    }
    histogram.forEach((count, index) => {
      if (!Number.isInteger(count) || count < 0) {
        throw new RangeError("Histogram counts must be nonnegative integers")
      }
      merged[index] += count
    })
  }
  return merged
}
