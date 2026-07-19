# Query performance benchmark, 2026-07-18

Tracked results for the database query optimization work in [PR #4](https://github.com/0xSMW/pulse-uptime/pull/4) (`perf/query-hillclimb`). Raw run artifacts live in [`Docs/benchmarks/`](benchmarks/) and every timing number below is derived from them. Statement counts and test totals come from the PR's validation record.

## Headline result

The measurable win of PR #4 is statement count, not per-query latency. At the supported 100-monitor scale every hot query already executes in under 5 ms warm, so the optimization work targeted round trips and duplicate work instead:

- The 100-monitor registry steady-state sync path drops from roughly **401 SQL statements to 5**.
- Notification fan-out uses **one insert regardless of recipient count**.
- Reporting and maintenance paths shed duplicate scans while preserving response shapes and transaction semantics.
- Six supporting indexes (migration `0004_spooky_rage.sql`) were added for scale-proofing and verified as **non-regressing** at current scale.

The 19-case benchmark confirmed **zero regressions**. Root row counts were identical across runs and all median deltas sit inside run-to-run noise.

## What changed and why it matters

Two different improvements are in play, and they are verified two different ways.

**1. Fewer statements per operation (the actual speedup).** Latency per query was already fine, but several paths issued one statement per monitor or per recipient, so total database time scaled linearly with fleet size. PR #4 rewrites these to set-based SQL:

| Path | Before | After |
| --- | --- | --- |
| Scheduler registry sync (`lib/scheduler/registry-sync.ts`, new) | Per-monitor statements, roughly 401 per steady-state pass at 100 monitors | 5 set-based statements regardless of fleet size |
| Notification fan-out (`lib/notifications/enqueue.ts`) | 1 insert per recipient | 1 multi-row insert per event |
| Reporting timelines and status (`lib/reporting/queries/`) | Repeated per-window scans | Single linear aggregation per request |
| Maintenance counts (`lib/maintenance/sql.ts`) | Redundant full counts | Consolidated counting queries |
| Config snapshot selection, API projections, principal activity (`lib/api/`) | Wider reads and per-call updates | Narrowed projections and batched updates |

These wins are structural, so they are verified by behavior tests rather than this timing benchmark: 538 tests passed plus live PostgreSQL rollback smoke tests covering registry sync, notification batching, maintenance counts, scheduler-gap selection, and the migration indexes.

**2. Latency non-regression (what this benchmark proves).** The rewrites and new indexes must not make any existing hot query slower. That is what the table below establishes, and flat results are the success criterion, not a disappointment.

## Methodology

- Harness: `scripts/query-performance/` on the `perf/query-hillclimb` branch. Deterministic fixtures, `EXPLAIN (ANALYZE, BUFFERS)` capture, 2 warmup runs then 7 measured samples per query, medians reported.
- Environment: temporary Neon Postgres project `falling-glade-31419684` in `aws-us-east-1`, created for the benchmark and deleted afterward. Production data was never touched.
- Fixture (version 1): 100 monitors, 36,000 `check_results`, 102,700 `metric_rollups`, 3,000 `daily_rollups`, 64 incidents, 113 outbox rows.
- Queries: 19 production read and claim paths extracted from `lib/monitoring/queries.ts`, status page routes, incident views, and the notification outbox. Each case records its source `file:line`.

Three runs are preserved:

| Artifact | Purpose |
| --- | --- |
| `baseline-recovery-…T17-53-39` | First clean baseline after harness recovery |
| `baseline-corrected-…T18-20-46` | Baseline after benchmark SQL corrections, the reference run |
| `candidate-indexes-…T18-25-04` | Same fixture with the six `0004` indexes applied |

## Results, median execution time (ms)

| Query | Baseline | With indexes | Delta |
| --- | ---: | ---: | ---: |
| dashboard-monitors-uptime24h | 4.857 | 4.894 | +0.8% |
| public-status-rollups-90d | 0.702 | 0.684 | -2.6% |
| notification-outbox-claim | 0.636 | 0.627 | -1.4% |
| monitor-detail-rollups-30d | 0.288 | 0.288 | 0.0% |
| monitor-detail-rollups-7d | 0.121 | 0.122 | +0.8% |
| incidents-list-all | 0.117 | 0.119 | +1.7% |
| public-status-monitors | 0.111 | 0.110 | -0.9% |
| command-palette-monitors | 0.105 | 0.108 | +2.9% |
| monitor-detail-rollups-90d | 0.082 | 0.082 | 0.0% |
| incidents-list-ongoing | 0.082 | 0.083 | +1.2% |
| public-status-recent-incidents-resolved | 0.076 | 0.076 | 0.0% |
| public-status-current-incidents | 0.071 | 0.073 | +2.8% |
| incidents-notification-summary | 0.056 | 0.057 | +1.8% |
| incident-detail-notifications | 0.052 | 0.049 | -5.8% |
| incident-detail-lookup | 0.048 | 0.048 | 0.0% |
| notification-outbox-reconcile-stale | 0.045 | 0.034 | -24.4% |
| monitor-identity-lookup | 0.044 | 0.044 | 0.0% |
| monitor-detail-recent-incidents | 0.042 | 0.042 | 0.0% |
| monitor-detail-accepted-config | 0.041 | 0.041 | 0.0% |

Reading the deltas: at sub-millisecond magnitudes the percentages are noise, including the -24.4% on `notification-outbox-reconcile-stale` (0.045 ms to 0.034 ms). The honest summary is flat, which is the intended outcome for a non-regression gate.

### The heaviest query

`dashboard-monitors-uptime24h` (the dashboard monitor list with the blended rollup plus raw-check 24h uptime subquery and active-incident join, `lib/monitoring/queries.ts:35-117`) dominates the profile:

- Warm median: **4.86 ms** for 98 rows, ~4,400 shared buffer hits, planning ~0.36 ms.
- Cold first execution (warmup capture): **~497 ms** with 1,212 blocks read from disk. Cold-cache cost is buffer population, not plan quality.

### Why the indexes show no latency change

The fixture is intentionally bounded to the supported 100-monitor scale. Target tables are small enough that PostgreSQL keeps sequential scans, so the six indexes (`api_tokens_active_creator`, `cli_sessions_installation`, `config_operations_principal_idempotency`, `incidents_feed_order`, `monitoring_config_snapshots_accepted_order`, `notification_outbox_incident`) are dormant at this cardinality. They exist to keep these paths flat as tables grow, and this benchmark establishes that adding them costs nothing today.

## Excluded queries

Eight paths were deliberately excluded, each with a recorded reason in the artifacts: `scheduler-fill-gaps`, `scheduler-compact-15-minute`, `scheduler-promote-rollup`, `auth-login-password-verify`, `token-verification-lookup`, `rate-limit-increment`, `idempotency-claim-upsert`, `notification-mark-sent-or-failed`. The scheduler CTEs depend on bit-packed live state that synthetic params would misrepresent, and the auth and mutation paths are dominated by hashing or write semantics rather than plan shape.

## Reproducing and comparing

These artifacts were produced with fixture version 1. The harness now requires `FIXTURE_VERSION = 3` (`scripts/query-performance/src/fixture-constants.ts`), so any future run must reseed fixtures first and new numbers are only comparable to other v3 runs. Treat this report as the frozen pre-merge record, and cut a fresh baseline on master after PR #4 lands.
