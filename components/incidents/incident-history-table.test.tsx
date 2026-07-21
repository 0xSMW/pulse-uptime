// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), prefetch: vi.fn() }),
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
  it("navigates the whole row to the incident on a plain left click", () => {
    renderTable();
    const link = screen.getByRole("link", { name: "API Production" });
    expect(link.getAttribute("href")).toBe("/incidents/inc-1");
    const row = link.closest("tr")!;
    expect(row.className).toContain("cursor-pointer");
    fireEvent.click(row, { button: 0 });
    expect(push).toHaveBeenCalledWith("/incidents/inc-1");
  });

  it("leaves clicks on the row's Write Report button to the button (finding: a naive row click would hijack inner controls)", () => {
    renderTable();
    const button = screen.getByRole("button", { name: "Write Report" });
    fireEvent.click(button, { button: 0 });
    expect(push).not.toHaveBeenCalledWith("/incidents/inc-1");
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
