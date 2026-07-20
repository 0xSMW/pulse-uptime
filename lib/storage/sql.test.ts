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

  it("resolves the accepted config per minute from precomputed effective ranges, not a per-minute lateral order-by", () => {
    expect(FILL_SCHEDULER_GAPS_SQL).not.toMatch(/order by accepted_at desc, seen_at desc limit 1/);
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("partition by accepted_at order by seen_at desc");
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("lead(accepted_at) over (order by accepted_at) next_accepted_at");
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("where accepted_at <= minute.scheduled_minute");
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("next_accepted_at is null or minute.scheduled_minute < next_accepted_at");
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("cross join lateral (select config_version, monitors from accepted_ranges");
  });

  it("extracts the monitors array once per accepted snapshot instead of once per missing minute", () => {
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("config_json->'monitors' monitors");
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("accepted_ranges as materialized");
    // config_json appears once as the extraction expression and once in the
    // comment explaining why accepted_ranges must stay materialized.
    expect(FILL_SCHEDULER_GAPS_SQL.match(/config_json/g)).toHaveLength(2);
    expect(FILL_SCHEDULER_GAPS_SQL).toContain("jsonb_array_elements(config.monitors)");
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
