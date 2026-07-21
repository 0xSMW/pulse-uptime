import { describe, expect, it } from "vitest"

import { sampleFromExplainOutput } from "../src/explain"

// The root buffer counters already include all child activity.
function nestedExplainOutput() {
  return {
    Plan: {
      "Node Type": "Hash Join",
      "Actual Total Time": 12.5,
      "Actual Rows": 100,
      "Actual Loops": 1,
      "Shared Hit Blocks": 100,
      "Shared Read Blocks": 20,
      "Shared Dirtied Blocks": 3,
      "Shared Written Blocks": 1,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Actual Total Time": 2,
          "Actual Rows": 50,
          "Actual Loops": 1,
          "Shared Hit Blocks": 40,
          "Shared Read Blocks": 8,
          "Shared Dirtied Blocks": 1,
          "Shared Written Blocks": 0,
        },
        {
          "Node Type": "Hash",
          "Actual Total Time": 4,
          "Actual Rows": 50,
          "Actual Loops": 1,
          "Shared Hit Blocks": 60,
          "Shared Read Blocks": 12,
          "Shared Dirtied Blocks": 2,
          "Shared Written Blocks": 1,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Actual Total Time": 3,
              "Actual Rows": 50,
              "Actual Loops": 1,
              "Shared Hit Blocks": 55,
              "Shared Read Blocks": 10,
              "Shared Dirtied Blocks": 2,
              "Shared Written Blocks": 1,
            },
          ],
        },
      ],
    },
    "Planning Time": 0.4,
    "Execution Time": 12.1,
  }
}

describe("sampleFromExplainOutput", () => {
  it("uses root plan buffer counters instead of summing nested nodes", () => {
    const output = nestedExplainOutput()
    const sample = sampleFromExplainOutput(output)

    // Query totals come from the root counters.
    expect(sample.sharedHitBlocks).toBe(100)
    expect(sample.sharedReadBlocks).toBe(20)
    expect(sample.sharedDirtiedBlocks).toBe(3)
    expect(sample.sharedWrittenBlocks).toBe(1)

    // Summing every node would double-count the buffers.
    const summedHits = 100 + 40 + 60 + 55
    const summedReads = 20 + 8 + 12 + 10
    expect(summedHits).toBe(255)
    expect(summedReads).toBe(50)
    expect(sample.sharedHitBlocks).not.toBe(summedHits)
    expect(sample.sharedReadBlocks).not.toBe(summedReads)
  })

  it("still flattens nested plans for nodeCount and topNodes", () => {
    const sample = sampleFromExplainOutput(nestedExplainOutput())

    expect(sample.nodeCount).toBe(4)
    expect(sample.topNodes).toHaveLength(4)
    expect(sample.topNodes.map((node) => node.nodeType)).toEqual([
      "Hash Join",
      "Seq Scan",
      "Hash",
      "Index Scan",
    ])

    // Top-node summaries keep their own counters.
    expect(sample.topNodes[0]!.sharedHitBlocks).toBe(100)
    expect(sample.topNodes[1]!.sharedHitBlocks).toBe(40)
    expect(sample.topNodes[2]!.sharedHitBlocks).toBe(60)
    expect(sample.topNodes[3]!.sharedHitBlocks).toBe(55)
  })

  it("preserves timing and root row fields from the explain output", () => {
    const sample = sampleFromExplainOutput(nestedExplainOutput())

    expect(sample.planningTimeMs).toBe(0.4)
    expect(sample.executionTimeMs).toBe(12.1)
    expect(sample.totalTimeMs).toBeCloseTo(12.5)
    expect(sample.rootRows).toBe(100)
  })

  it("defaults missing buffer counters on a leaf root plan to zero", () => {
    const sample = sampleFromExplainOutput({
      Plan: {
        "Node Type": "Result",
        "Actual Total Time": 0.01,
        "Actual Rows": 1,
        "Actual Loops": 1,
      },
      "Planning Time": 0.1,
      "Execution Time": 0.01,
    })

    expect(sample.sharedHitBlocks).toBe(0)
    expect(sample.sharedReadBlocks).toBe(0)
    expect(sample.sharedDirtiedBlocks).toBe(0)
    expect(sample.sharedWrittenBlocks).toBe(0)
    expect(sample.nodeCount).toBe(1)
    expect(sample.topNodes).toHaveLength(1)
  })

  it("caps topNodes at five while counting the full nested tree", () => {
    const sample = sampleFromExplainOutput({
      Plan: {
        "Node Type": "Append",
        "Actual Rows": 6,
        "Shared Hit Blocks": 6,
        "Shared Read Blocks": 0,
        Plans: Array.from({ length: 6 }, (_, index) => ({
          "Node Type": `Leaf ${index}`,
          "Actual Rows": 1,
          "Shared Hit Blocks": 1,
          "Shared Read Blocks": 0,
        })),
      },
      "Planning Time": 0,
      "Execution Time": 1,
    })
    expect(sample.nodeCount).toBe(7)
    expect(sample.topNodes).toHaveLength(5)
    expect(sample.sharedHitBlocks).toBe(6)
    expect(sample.sharedReadBlocks).toBe(0)
  })
})
