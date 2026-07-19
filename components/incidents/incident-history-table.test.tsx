// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { TimezoneProvider } from "@/components/dashboard/timezone-provider";
import { IncidentHistoryTable } from "./incident-history-table";
import type { IncidentSummary } from "./types";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const incident: IncidentSummary = {
  id: "inc-1",
  monitorId: "mon-1",
  monitorName: "API Production",
  openedAt: "2026-07-18T09:00:00.000Z",
  resolvedAt: "2026-07-18T09:30:00.000Z",
  durationSeconds: 1800,
  openingFailure: "HTTP 503",
  status: "resolved",
  notificationSummary: { state: "sent", sentCount: 1 },
};

function renderTable() {
  return render(
    <TimezoneProvider>
      <IncidentHistoryTable incidents={[incident]} />
    </TimezoneProvider>,
  );
}

describe("IncidentHistoryTable", () => {
  it("scopes the monitor link overlay to its cell (finding: relative on tr is not a containing block in WebKit, so the after:inset-0 overlay covered the page and the Reports tab clicked through to the incident detail)", () => {
    renderTable();
    const link = screen.getByRole("link", { name: "API Production" });
    expect(link.className).toContain("after:absolute");
    expect(link.className).toContain("after:inset-0");
    expect(link.getAttribute("href")).toBe("/incidents/inc-1");
    const cell = link.closest("td")!;
    expect(cell.className).toContain("relative");
    const row = link.closest("tr")!;
    expect(row.className).not.toContain("relative");
  });

  it("does not render a Status column (finding: it duplicated the HTTP code already shown by Opening Failure)", () => {
    renderTable();
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toContain("Opening Failure");
    expect(headers).not.toContain("Status");
    expect(screen.getByText("HTTP 503")).toBeTruthy();
    expect(screen.queryByText("resolved")).toBeNull();
  });
});
