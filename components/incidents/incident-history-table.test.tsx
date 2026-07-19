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
  it("raises the actions cell above the row's full-row click overlay (finding: Write Report overlapped the after:inset-0 monitor link, so clicks landed on row navigation instead of the button)", () => {
    renderTable();
    const button = screen.getByRole("button", { name: "Write Report" });
    const cell = button.closest("td")!;
    expect(cell.className).toContain("relative");
    expect(cell.className).toContain("z-10");
  });

  it("still renders the monitor link with the full-row click overlay", () => {
    renderTable();
    const link = screen.getByRole("link", { name: "API Production" });
    expect(link.className).toContain("after:absolute");
    expect(link.className).toContain("after:inset-0");
    expect(link.getAttribute("href")).toBe("/incidents/inc-1");
  });
});
