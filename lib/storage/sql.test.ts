import { describe, expect, it } from "vitest";

import { COMPACT_15_MINUTE_SQL, FILL_SCHEDULER_GAPS_SQL, MEASURE_USAGE_SQL, PROMOTE_ROLLUP_SQL } from "./sql";

describe("storage maintenance SQL", () => {
  it("compacts explicit missing completion as Unknown idempotently", () => {
    expect(COMPACT_15_MINUTE_SQL).toContain("completed = 0");
    expect(COMPACT_15_MINUTE_SQL).toContain("unknown_checks");
    expect(COMPACT_15_MINUTE_SQL).toContain("on conflict (monitor_id, resolution, bucket_start) do update");
    expect(COMPACT_15_MINUTE_SQL).not.toContain("check_results");
    expect(COMPACT_15_MINUTE_SQL).toContain("batch.latency_values");
  });

  it("materializes entirely missing scheduler minutes idempotently", () => {
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("generate_series");
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("max(bucket_start) + interval '15 minutes'");
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("where resolution = '15m'");
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("coalesce(coverage.covered_until, accepted_start.accepted_at");
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("on conflict (scheduled_minute) do nothing");
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("'scheduler_gap'");
  });

  it("promotes mergeable histogram buckets in database", () => {
    expect(PROMOTE_ROLLUP_SQL).toContain("sum(latency_histogram[8])");
    expect(PROMOTE_ROLLUP_SQL).toContain("on conflict (monitor_id, resolution, bucket_start) do update");
  });

  it("measures relation and index allocation and writes one daily snapshot", () => {
    expect(MEASURE_USAGE_SQL).toContain("pg_total_relation_size");
    expect(MEASURE_USAGE_SQL).toContain("pg_indexes_size");
    // Images and status report content are TOASTed, so the category uses the
    // total-relation measure (minus indexes, which have their own category).
    expect(MEASURE_USAGE_SQL).toContain("'content', coalesce(sum(total_bytes - index_bytes) filter (where relname in ('images','status_page_config','status_reports','status_report_updates','status_report_affected')), 0)");
    expect(MEASURE_USAGE_SQL).toContain("select $1::timestamptz");
    expect(MEASURE_USAGE_SQL).not.toContain("select date_trunc('day', $1");
    expect(MEASURE_USAGE_SQL).toContain("on conflict (captured_at) do update");
  });
});
