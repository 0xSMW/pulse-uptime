// Verify benchmark cases match production sources, joins, and scan windows.
// Query construction uses an unroutable lazy client without network I/O.

import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import * as schema from "../../../lib/db/schema";
import { queryCases } from "../src/query-cases";
import type { GatedConnection } from "../src/db-connection";
import type { SampleContext } from "../src/sample-context";
import type { TempProjectState } from "../src/local-state";

const FAKE_PROJECT_STATE: TempProjectState = {
  marker: "query-performance-temp-project",
  projectId: "test-only-never-connects",
  projectName: "test-only-never-connects",
  regionId: "none",
  createdAt: new Date(0).toISOString(),
  database: "test-never-connects",
  role: "test",
  host: "0.0.0.0",
};

const FAKE_SAMPLE_CONTEXT: SampleContext = {
  now: new Date("2026-01-01T00:00:00Z"),
  monitorIds: Array.from({ length: 10 }, (_, index) => `qh-monitor-${String(index + 1).padStart(4, "0")}`),
  groupSlug: "api",
  ongoingIncidentId: "00000000-0000-0000-0000-000000000001",
  resolvedIncidentId: "00000000-0000-0000-0000-000000000002",
  incidentMonitorId: "qh-monitor-0001",
};

function fakeConnection(): GatedConnection {
  const sql = postgres("postgres://test:test@0.0.0.0:1/test-never-connects", { max: 1 });
  const db = drizzle(sql, { schema });
  return { project: FAKE_PROJECT_STATE, sql, db };
}

function findCase(name: string) {
  const found = queryCases.find((entry) => entry.name === name);
  if (!found) throw new Error(`query case not found: ${name}`);
  return found;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// postgres.js serializes Date parameters before they enter `ResolvedQuery.params`.
// Window assertions parse the resulting ISO strings.
function dateParams(params: unknown[]): Date[] {
  return params.filter((param): param is string => typeof param === "string" && ISO_DATE.test(param)).map((param) => new Date(param));
}

describe("dashboard monitor query sources", () => {
  it("references production monitoring queries", () => {
    expect(findCase("dashboard-monitors-uptime24h").source).toMatch(/^lib\/monitoring\/queries\.ts/);
    expect(findCase("command-palette-monitors").source).toMatch(/^lib\/monitoring\/queries\.ts/);
    expect(findCase("dashboard-monitors-uptime24h").source).not.toContain("lib/reporting/queries/status.ts");
    expect(findCase("command-palette-monitors").source).not.toContain("lib/reporting/queries/status.ts");
  });
});

describe("dashboard monitor incident join", () => {
  it("joins only open incidents by monitor", () => {
    const built = findCase("dashboard-monitors-uptime24h").build(fakeConnection(), FAKE_SAMPLE_CONTEXT);
    expect(built.text).toMatch(/left join "incidents"/i);
    expect(built.text).toMatch(/"incidents"\."resolved_at" is null/i);
  });

  it("selects blended rollup and raw uptime", () => {
    const built = findCase("dashboard-monitors-uptime24h").build(fakeConnection(), FAKE_SAMPLE_CONTEXT);
    expect(built.text).toMatch(/cross join lateral/i);
  });
});

describe("monitor detail rollup windows", () => {
  it("names the 15m case for its seven day scan window", () => {
    const names = queryCases.map((entry) => entry.name);
    expect(names).toContain("monitor-detail-rollups-7d");
    expect(names).not.toContain("monitor-detail-rollups-24h");
  });

  it("names hour and day cases for production windows", () => {
    const names = queryCases.map((entry) => entry.name);
    expect(names).toContain("monitor-detail-rollups-30d");
    expect(names).toContain("monitor-detail-rollups-90d");
  });

  it("scans seven days for 15m rollups", () => {
    const built = findCase("monitor-detail-rollups-7d").build(fakeConnection(), FAKE_SAMPLE_CONTEXT);
    const [start, end] = dateParams(built.params);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(end!.getTime() - start!.getTime()).toBe(7 * 86_400_000);
  });

  it("scans 30 and 90 days for hour and day rollups", () => {
    const thirtyDay = findCase("monitor-detail-rollups-30d").build(fakeConnection(), FAKE_SAMPLE_CONTEXT);
    const [thirtyStart, thirtyEnd] = dateParams(thirtyDay.params);
    expect(thirtyEnd!.getTime() - thirtyStart!.getTime()).toBe(30 * 86_400_000);

    const ninetyDay = findCase("monitor-detail-rollups-90d").build(fakeConnection(), FAKE_SAMPLE_CONTEXT);
    const [ninetyStart, ninetyEnd] = dateParams(ninetyDay.params);
    expect(ninetyEnd!.getTime() - ninetyStart!.getTime()).toBe(90 * 86_400_000);
  });

  it("references production monitor reporting queries", () => {
    for (const name of ["monitor-detail-rollups-7d", "monitor-detail-rollups-30d", "monitor-detail-rollups-90d"]) {
      expect(findCase(name).source).toMatch(/^lib\/reporting\/queries\/monitors\.ts/);
    }
  });
});

describe("query case inventory", () => {
  it("uses unique names", () => {
    const names = queryCases.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
