import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

// A resolved incident opened before its monitor activated is a setup-phase
// failure, so the first-run activation gate drops it from every per-monitor
// incident surface and blocks its promotion into a public report. A genuine
// ongoing incident and a normal post-activation incident stay visible.
suite("incident activation gate", () => {
  const client = postgres(databaseUrl!, { max: 1, prepare: false });

  let listIncidents: typeof import("./incidents").listIncidents;
  let getIncidentDetail: typeof import("./incidents").getIncidentDetail;
  let listCommandPaletteIncidents: typeof import("./incidents").listCommandPaletteIncidents;
  let operationalService: typeof import("@/lib/api/operational-service").operationalService;
  let promoteIncident: typeof import("@/lib/api/status-reports").promoteIncident;
  let StatusReportError: typeof import("@/lib/api/status-reports").StatusReportError;
  let closeModuleConnection: () => Promise<void>;

  const ACTIVATED = new Date("2026-07-10T00:00:00.000Z");
  // mon-act activated on 2026-07-10.
  const INC_PRE = "11111111-1111-4111-8111-000000000001"; // resolved before activation
  const INC_POST = "11111111-1111-4111-8111-000000000002"; // resolved after activation
  const INC_LIVE = "11111111-1111-4111-8111-000000000003"; // ongoing after activation
  // mon-setup never activated.
  const INC_SETUP_RESOLVED = "11111111-1111-4111-8111-000000000004";
  const INC_SETUP_LIVE = "11111111-1111-4111-8111-000000000005"; // ongoing, but setup noise
  // mon-recover never succeeded before its outage, is recovering with an active
  // incident during the backfill, so its earliest success postdates the incident.
  const INC_RECOVER = "11111111-1111-4111-8111-000000000006"; // ongoing, first successes postdate it
  const RECOVER_OPENED = new Date("2026-07-14T00:00:00.000Z");

  async function seed(): Promise<void> {
    const now = new Date("2026-07-20T00:00:00.000Z");
    for (const monitor of [
      { id: "mon-act", name: "Activated", activatedAt: ACTIVATED },
      { id: "mon-setup", name: "Setup", activatedAt: null },
    ]) {
      await client`insert into monitor_registry (id, name, url, enabled, config_hash, first_seen_at, last_seen_at)
        values (${monitor.id}, ${monitor.name}, ${"https://example.test"}, true, ${"hash"}, ${now}, ${now})`;
      await client`insert into monitor_state (monitor_id, state, activated_at, updated_at)
        values (${monitor.id}, ${"UP"}, ${monitor.activatedAt}, ${now})`;
    }

    const incidentRows = [
      { id: INC_PRE, monitor: "mon-act", opened: new Date("2026-07-05T00:00:00.000Z"), resolved: new Date("2026-07-06T00:00:00.000Z") },
      { id: INC_POST, monitor: "mon-act", opened: new Date("2026-07-12T00:00:00.000Z"), resolved: new Date("2026-07-13T00:00:00.000Z") },
      { id: INC_LIVE, monitor: "mon-act", opened: new Date("2026-07-11T00:00:00.000Z"), resolved: null },
      { id: INC_SETUP_RESOLVED, monitor: "mon-setup", opened: new Date("2026-07-08T00:00:00.000Z"), resolved: new Date("2026-07-09T00:00:00.000Z") },
      { id: INC_SETUP_LIVE, monitor: "mon-setup", opened: new Date("2026-07-08T12:00:00.000Z"), resolved: null },
    ];
    for (const incident of incidentRows) {
      await client`insert into incidents (id, monitor_id, opened_at, first_failure_at, first_success_at, resolved_at, opening_status_code, created_at, updated_at)
        values (
          ${incident.id}, ${incident.monitor}, ${incident.opened}, ${incident.opened},
          ${incident.resolved}, ${incident.resolved}, ${503}, ${now}, ${now}
        )`;
    }

    // mon-recover reproduces the recovery race. It never succeeded before the
    // outage, so activated_at is null at backfill time, active_incident_id points
    // at an ongoing incident opened before any success, and its recorded first and
    // last success plus its only successful rollup bucket all postdate that open.
    const recoverSuccess = new Date("2026-07-15T00:00:00.000Z");
    await client`insert into monitor_registry (id, name, url, enabled, config_hash, first_seen_at, last_seen_at)
      values (${"mon-recover"}, ${"Recover"}, ${"https://example.test"}, true, ${"hash"}, ${now}, ${now})`;
    await client`insert into monitor_state (monitor_id, state, activated_at, active_incident_id, first_failure_at, first_success_at, last_success_at, consecutive_successes, updated_at)
      values (
        ${"mon-recover"}, ${"VERIFYING_UP"}, ${null}, ${INC_RECOVER}, ${RECOVER_OPENED},
        ${recoverSuccess}, ${recoverSuccess}, ${1}, ${now}
      )`;
    await client`insert into incidents (id, monitor_id, opened_at, first_failure_at, first_success_at, resolved_at, opening_status_code, created_at, updated_at)
      values (${INC_RECOVER}, ${"mon-recover"}, ${RECOVER_OPENED}, ${RECOVER_OPENED}, ${null}, ${null}, ${503}, ${now}, ${now})`;
    await client`insert into metric_rollups (
      monitor_id, resolution, bucket_start, expected_checks, completed_checks, successful_checks,
      failed_checks, unknown_checks, downtime_seconds, unknown_seconds, latency_count, latency_sum_ms,
      latency_min_ms, latency_max_ms, latency_histogram, histogram_version, has_incident, compacted_at
    ) values (
      ${"mon-recover"}, ${"15m"}, ${recoverSuccess}, ${1}, ${1}, ${1}, ${0}, ${0}, ${0}, ${0}, ${1}, ${100},
      ${100}, ${100}, ${[0, 0, 0, 0, 0, 0, 0, 0]}, ${1}, ${false}, ${now}
    )`;

    // mon-old is a long-lived healthy monitor whose true first success predates
    // raw check_results retention. Only a newer raw success survives, while an
    // older successful rollup bucket still records the real start. Activation must
    // anchor at the earliest evidence (the old rollup) rather than the newest
    // retained raw check, so d30 and d90 stay unlocked and old history stays real.
    const oldFirstBucket = new Date("2026-05-01T00:00:00.000Z");
    const retainedRawSuccess = new Date("2026-07-19T00:00:00.000Z");
    await client`insert into monitor_registry (id, name, url, enabled, config_hash, first_seen_at, last_seen_at)
      values (${"mon-old"}, ${"Old"}, ${"https://example.test"}, true, ${"hash"}, ${now}, ${now})`;
    await client`insert into monitor_state (monitor_id, state, activated_at, first_success_at, last_success_at, updated_at)
      values (${"mon-old"}, ${"UP"}, ${null}, ${null}, ${retainedRawSuccess}, ${now})`;
    await client`insert into check_results (monitor_id, run_id, scheduled_at, checked_at, successful, status_code, latency_ms, created_at)
      values (${"mon-old"}, ${"22222222-2222-4222-8222-000000000001"}, ${retainedRawSuccess}, ${retainedRawSuccess}, ${true}, ${200}, ${100}, ${now})`;
    await client`insert into metric_rollups (
      monitor_id, resolution, bucket_start, expected_checks, completed_checks, successful_checks,
      failed_checks, unknown_checks, downtime_seconds, unknown_seconds, latency_count, latency_sum_ms,
      latency_min_ms, latency_max_ms, latency_histogram, histogram_version, has_incident, compacted_at
    ) values (
      ${"mon-old"}, ${"day"}, ${oldFirstBucket}, ${1}, ${1}, ${1}, ${0}, ${0}, ${0}, ${0}, ${1}, ${100},
      ${100}, ${100}, ${[0, 0, 0, 0, 0, 0, 0, 0]}, ${1}, ${false}, ${now}
    )`;

    // Re-run the data backfill from migration 0013 against the seeded pre-state.
    // The migrations already ran against empty tables in beforeAll, so the UPDATE
    // statements are replayed to exercise the success, active-incident, and clamp
    // passes on mon-recover. The DDL ALTER is skipped, the column already exists.
    const backfill = await readFile(resolve(process.cwd(), "drizzle", "0013_worried_hairball.sql"), "utf8");
    for (const statement of backfill.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
      if (!statement.toUpperCase().includes("ADD COLUMN")) await client.unsafe(statement);
    }
  }

  beforeAll(async () => {
    const dir = resolve(process.cwd(), "drizzle");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    for (const migration of files) {
      const source = await readFile(resolve(dir, migration), "utf8");
      for (const statement of source.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
        await client.unsafe(statement);
      }
    }
    await seed();
    // The modules under test bind their db client to DATABASE_URL at import
    // time, so the env var must point at the test database before the dynamic
    // imports below evaluate lib/db/client.ts.
    process.env.DATABASE_URL = databaseUrl;
    ({ listIncidents, getIncidentDetail, listCommandPaletteIncidents } = await import("./incidents"));
    ({ operationalService } = await import("@/lib/api/operational-service"));
    ({ promoteIncident, StatusReportError } = await import("@/lib/api/status-reports"));
    const { sql } = await import("@/lib/db/client");
    closeModuleConnection = () => sql.end();
  }, 30_000);

  afterAll(async () => {
    await closeModuleConnection?.();
    await client.end();
  });

  it("keeps post-activation and ongoing incidents in the dashboard list while dropping pre-activation and setup noise", async () => {
    const rows = await listIncidents("all");
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(INC_POST);
    expect(ids).toContain(INC_LIVE);
    expect(ids).not.toContain(INC_PRE);
    expect(ids).not.toContain(INC_SETUP_RESOLVED);
    expect(ids).not.toContain(INC_SETUP_LIVE);
  });

  it("drops pre-activation resolved incidents from the resolved filter", async () => {
    const ids = (await listIncidents("resolved")).map((row) => row.id);
    expect(ids).toEqual([INC_POST]);
  });

  it("keeps only genuine ongoing incidents in the command palette", async () => {
    const ids = (await listCommandPaletteIncidents()).map((row) => row.id);
    expect(ids).toEqual([INC_RECOVER, INC_LIVE]);
  });

  it("resolves a pre-activation incident detail as not found and a post-activation one as present", async () => {
    expect(await getIncidentDetail(INC_PRE)).toBeNull();
    expect((await getIncidentDetail(INC_POST))?.id).toBe(INC_POST);
  });

  it("gates the incidents API feed the same way", async () => {
    const page = await operationalService.listIncidents({ cursor: null, limit: 50 });
    const ids = page.data.map((row) => row.id);
    expect(ids).toContain(INC_POST);
    expect(ids).toContain(INC_LIVE);
    expect(ids).not.toContain(INC_PRE);
    expect(ids).not.toContain(INC_SETUP_RESOLVED);
    expect(ids).not.toContain(INC_SETUP_LIVE);
  });

  it("gates the incidents API per-incident fetch", async () => {
    expect(await operationalService.getIncident(INC_PRE)).toBeNull();
    expect((await operationalService.getIncident(INC_POST))?.id).toBe(INC_POST);
  });

  it("blocks promotion of a pre-activation setup incident but promotes a real one", async () => {
    await expect(promoteIncident(INC_PRE)).rejects.toBeInstanceOf(StatusReportError);
    await expect(promoteIncident(INC_PRE)).rejects.toMatchObject({ code: "INCIDENT_NOT_FOUND" });
    await expect(promoteIncident(INC_SETUP_LIVE)).rejects.toMatchObject({ code: "INCIDENT_NOT_FOUND" });

    const promoted = await promoteIncident(INC_LIVE);
    expect(promoted.report.originIncidentId).toBe(INC_LIVE);
  });

  it("clamps activated_at to the ongoing incident open so a recovery-race outage stays visible", async () => {
    const [state] = await client<{ activatedAt: Date }[]>`
      select activated_at as "activatedAt" from monitor_state where monitor_id = ${"mon-recover"}`;
    // The success pass set activated_at to the recovery time after the incident
    // open, then the clamp pulled it back to at or before the incident open.
    expect(state.activatedAt.getTime()).toBeLessThanOrEqual(RECOVER_OPENED.getTime());

    const listIds = (await listIncidents("all")).map((row) => row.id);
    expect(listIds).toContain(INC_RECOVER);
    const paletteIds = (await listCommandPaletteIncidents()).map((row) => row.id);
    expect(paletteIds).toContain(INC_RECOVER);
    expect((await getIncidentDetail(INC_RECOVER))?.id).toBe(INC_RECOVER);
    expect((await operationalService.getIncident(INC_RECOVER))?.id).toBe(INC_RECOVER);

    const promoted = await promoteIncident(INC_RECOVER);
    expect(promoted.report.originIncidentId).toBe(INC_RECOVER);
  });

  it("anchors activation at the earliest evidence when a first success predates raw retention", async () => {
    const [state] = await client<{ activatedAt: Date }[]>`
      select activated_at as "activatedAt" from monitor_state where monitor_id = ${"mon-old"}`;
    // The old successful day rollup ends 2026-05-02, well before the only retained
    // raw success on 2026-07-19, so LEAST anchors activation at the old start
    // rather than the newest retained check.
    expect(state.activatedAt.getTime()).toBe(new Date("2026-05-02T00:00:00.000Z").getTime());
  });
});
