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
    expect(ids).toEqual([INC_LIVE]);
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
});
