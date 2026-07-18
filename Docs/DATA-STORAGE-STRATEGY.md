Given a 0.5 GB ceiling, I’d use a **compressed, exception-first telemetry model with adaptive retention**. The durable product history becomes incidents, exceptions, daily uptime, and latency distributions; successful minute-level checks exist only briefly in packed form.

### Recommended storage model

1. **One packed batch per cron minute**

   Store a single row covering all monitors:

- Expected and completed monitor bitmaps
- Latency as a compact integer array
- Failure bitmap
- Scheduler timestamps and configuration version

   At 100 monitors, each batch should remain around 0.5–1 KB. Keep these batches for 24–48 hours, giving roughly 1–3 MB of hot telemetry.

2. **Exact exception history**

   Persist failures, recoveries, pauses, resumptions, scheduler gaps, and configuration changes. Collapse repeated identical failures into one record:

   ```text
   error_code
   first_seen_at
   last_seen_at
   occurrence_count
   worst_latency_ms
   incident_id
   ```

   An outage producing 60 identical failures therefore consumes one evolving record.

3. **Mergeable rollups**

   Each rollup contains:

- Expected, completed, successful, failed, and unknown checks
- Downtime and unknown seconds
- Latency count, sum, minimum, maximum
- A small fixed-bucket latency histogram

   Use SQL inside Neon to compact the packed batches, avoiding data transfer back to Vercel.

### Retention ladder

| Data | Retention |
|---|---:|
| Packed minute batches | 48 hours |
| 15-minute rollups | 7 days |
| Hourly rollups | Days 8–30 |
| Daily rollups | Days 31–730 |
| Incidents | Indefinite |
| Compressed exceptions | 2 years |
| Detailed exception payloads | 30 days |

At 100 monitors, this produces about 192,000 rollup rows. A reasonable target is:

- Rollups: 75–140 MB
- Exceptions and incidents: maximum 50 MB
- Core tables, indexes, and authentication: 40–60 MB
- Operational headroom and history: at least 250 MB

### Minimize transfer

- Insert all results with one database request per cron minute.
- Return no rows from routine writes.
- Perform compaction with `INSERT … SELECT` inside Postgres.
- Query only pre-aggregated buckets for dashboards.
- Cache public status responses at Vercel.
- Invalidate cached status only on state changes or completed buckets.
- Limit charts to the requested resolution and date range.

This should keep ordinary Neon transfer well below 5 GB. Endpoint checks themselves travel between Vercel and monitored websites, outside the Neon data-transfer budget.

### Adaptive budget governor

Run a daily controller that measures table and index sizes using `pg_total_relation_size`, estimates 30-day growth, and changes retention automatically:

| Storage projection | Response |
|---|---|
| Below 60% | Full configured detail |
| 60–75% | Compact completed buckets early |
| 75–85% | Shorten minute and 15-minute retention |
| 85–95% | Keep hourly detail only around incidents |
| Above 95% | Preserve current state, incidents, and daily rollups only |

High-value data receives priority: incidents first, uptime second, latency distributions third, fine-grained successful checks last. Stable monitors naturally consume less detail, while monitors with failures or unusual latency retain higher-resolution windows around those events.

Scheduler coverage remains explicit. Missing checks produce **Unknown** periods, preventing a stalled cron system from being interpreted as healthy.

Add a **Database Health** section to Settings that answers three questions:

1. How much storage are we using?
2. What data consumes it?
3. Will the automatic retention policy keep us within budget?

```text
┌──────────────────────────────────────────────────────────────┐
│ Database Health                                      Healthy │
│ Storage remains within its configured budget                 │
│                                                              │
│ STORAGE                                                      │
│ 118 MB of 500 MB                                             │
│ ████████████░░░░░░░░░░░░░░░░░░░░░░░░  24%                  │
│ Projected in 30 days  146 MB       Available  382 MB         │
│                                                              │
│ DATA BREAKDOWN                                               │
│ Rollups                 62 MB   ███████████████░░░  53%      │
│ Exceptions              18 MB   ████░░░░░░░░░░░░░░  15%      │
│ Incidents                9 MB   ██░░░░░░░░░░░░░░░░   8%      │
│ Recent check batches     3 MB   █░░░░░░░░░░░░░░░░░   3%      │
│ Core data                8 MB   ██░░░░░░░░░░░░░░░░   7%      │
│ Indexes                  14 MB  ███░░░░░░░░░░░░░░░  12%      │
│ Other                     4 MB  █░░░░░░░░░░░░░░░░░   2%      │
│                                                              │
│ RETENTION                                                    │
│ Recent checks       48 hours          Oldest  31h ago        │
│ 15-minute rollups    7 days            Oldest   6 days       │
│ Hourly rollups      30 days            Oldest  29 days       │
│ Daily rollups        2 years           Oldest  84 days       │
│                                                              │
│ AUTOMATIC MANAGEMENT                                         │
│ Mode                 Full detail                             │
│ Last compacted       18 Jul, 03:17 UTC                       │
│ Scheduler coverage   99.99%                                  │
│ Next action          None required                           │
│                                                              │
│ NETWORK                                                      │
│ 420 MB of 5 GB this month             Projected  690 MB      │
│                                                    [Refresh] │
└──────────────────────────────────────────────────────────────┘
```

### How to calculate it

Postgres can provide physical allocation by table:

- `pg_relation_size()` for table data
- `pg_indexes_size()` for indexes
- `pg_total_relation_size()` for the combined physical footprint
- Row counts and oldest timestamps from each retention table

Map tables into user-facing categories:

```text
Recent check batches → check_batches
Rollups             → metric_rollups
Exceptions          → monitor_exceptions
Incidents           → incidents + incident_events
Core data           → monitors + users + configuration
Operations          → cron runs + notification outbox
```

Neon’s reported project storage may exceed the sum of those categories because of history, branches, system data, and delayed reclamation. Display that difference as **Other** rather than pretending every byte can be attributed.

### Usage snapshots

Have daily maintenance write one compact `database_usage_snapshots` row:

```text
captured_at
storage_bytes
index_bytes
category_bytes
history_bytes
monthly_transfer_bytes
projected_30_day_bytes
governor_mode
last_compaction_at
scheduler_coverage
```

Keep daily snapshots for 90 days and monthly snapshots thereafter. This makes growth projection inexpensive and allows a small historical usage graph without repeatedly scanning metadata.

The Settings page should read the most recent snapshot. **Refresh** can enqueue or run a new measurement server-side, with results cached for 15 minutes.

### Health states

- **Healthy:** projected storage below 60%
- **Watching:** projected storage between 60–75%
- **Optimizing:** automatic compaction has accelerated
- **Protecting:** above 85%; fine-grained retention is shrinking
- **Critical:** above 95% or maintenance is failing
- **Unknown:** usage or provider metrics are stale

The key UX detail is showing the governor’s current behavior. “Optimizing — hourly data older than 14 days is being compacted” is much more useful than a generic storage warning.
