import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("rollup reporting boundaries", () => {
  it.each(["monitors.ts", "status.ts"])("keeps %s off legacy raw telemetry", async (file) => {
    const source = await readFile(resolve(process.cwd(), "lib/reporting/queries", file), "utf8");
    expect(source).toContain("metricRollups");
    expect(source).not.toContain("checkResults");
    expect(source).not.toContain("dailyRollups");
    expect(source).toContain("gte(metricRollups.bucketStart");
    expect(source).toContain("lt(metricRollups.bucketStart");
    expect(source).toContain("eq(metricRollups.resolution");
  });
});
