import { describe, expect, it } from "vitest"

import { histogramFor, mergeHistograms } from "./histogram"

describe("fixed latency histogram", () => {
  it("merges without raw samples", () => {
    const left = histogramFor([50, 250, 501])
    const right = histogramFor([100, 251, 11_000])
    expect(mergeHistograms([left, right])).toEqual(
      histogramFor([50, 250, 501, 100, 251, 11_000])
    )
  })
})
