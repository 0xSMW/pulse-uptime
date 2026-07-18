import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DatabaseHealth } from "@/lib/database-health/types";
import { DatabaseHealthCard, formatDatabaseBytes, formatRetention } from "./database-health";

const report: DatabaseHealth = {
  health: "HEALTHY",
  summary: "Storage remains within its configured budget",
  budgetBytes: 500_000_000,
  usedBytes: 118_000_000,
  availableBytes: 382_000_000,
  projected30DayBytes: 146_000_000,
  categories: [
    { key: "rollups", label: "Rollups", bytes: 62_000_000 },
    { key: "other", label: "Other", bytes: 4_000_000 },
  ],
  retention: [{ key: "recent", label: "Recent checks", configuredSeconds: 172_800, oldestAt: "2026-07-17T05:00:00.000Z" }],
  governor: { mode: "FULL_DETAIL", action: "Keeping full configured detail", lastCompactionAt: "2026-07-18T03:17:00.000Z" },
  schedulerCoverage: 0.9999,
  transfer: { usedBytes: 420_000_000, budgetBytes: 5_000_000_000, projectedBytes: 690_000_000 },
  freshness: { capturedAt: "2026-07-18T11:55:00.000Z", ageSeconds: 300, stale: false, providerMetricsAvailable: true, providerCapturedAt: "2026-07-18T11:54:00.000Z", providerAgeSeconds: 360 },
  maintenanceHealthy: true,
  refresh: { cached: false, status: "CURRENT", nextEligibleAt: "2026-07-18T12:10:00.000Z" },
};

describe("DatabaseHealthCard", () => {
  it("renders budget, attribution, retention, management, transfer, and freshness", () => {
    const html = renderToStaticMarkup(<DatabaseHealthCard initialData={report} />);
    expect(html).toContain("Healthy");
    expect(html).toContain("118 MB of 500 MB");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="24"');
    expect(html).toContain("Other");
    expect(html).toContain("Recent checks");
    expect(html).toContain("Keeping full configured detail");
    expect(html).toContain("99.99%");
    expect(html).toContain("Projected this month");
    expect(html).toContain("Updated Jul 18");
  });

  it("renders a contained empty state", () => {
    const html = renderToStaticMarkup(<DatabaseHealthCard initialData={null} />);
    expect(html).toContain("No usage snapshot yet");
    expect(html).toContain(">Refresh</button>");
  });

  it("distinguishes a failed read from an empty database", () => {
    const html = renderToStaticMarkup(<DatabaseHealthCard initialData={null} initialError />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Database health unavailable");
    expect(html).not.toContain("No usage snapshot yet");
  });

  it("keeps partial relation data and marks unknown usage as indeterminate", () => {
    const partial: DatabaseHealth = {
      ...report,
      health: "UNKNOWN",
      usedBytes: null,
      availableBytes: null,
      freshness: { ...report.freshness, providerMetricsAvailable: false, providerCapturedAt: null, providerAgeSeconds: null },
    };
    const html = renderToStaticMarkup(<DatabaseHealthCard initialData={partial} />);
    expect(html).toContain("Provider metrics unavailable, relation usage remains current");
    expect(html).toContain('aria-valuetext="Storage usage unavailable"');
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain("Rollups");
  });
});

describe("database health formatting", () => {
  it("uses decimal byte units and pithy retention ages", () => {
    expect(formatDatabaseBytes(500_000_000)).toBe("500 MB");
    expect(formatDatabaseBytes(null)).toBe("Unavailable");
    expect(formatRetention(172_800)).toBe("2 days");
  });
});
