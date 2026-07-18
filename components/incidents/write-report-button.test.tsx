// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, refresh: navigation.refresh }),
}));

import { WriteReportButton } from "./write-report-button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("WriteReportButton", () => {
  it("promotes the incident and opens the draft report editor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "rep-7" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WriteReportButton incidentId="inc-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Write Report" }));
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith("/incidents/reports/rep-7");
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/incidents/inc-1/promote");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeTruthy();
  });

  it("navigates to the existing report when promotion returns one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "rep-existing" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WriteReportButton incidentId="inc-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Write Report" }));
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith("/incidents/reports/rep-existing");
    });
  });

  it("surfaces API failures inline and re-enables the button", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "INCIDENT_NOT_FOUND", message: "Incident was not found" } }), {
        status: 404,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<WriteReportButton incidentId="inc-9" />);
    fireEvent.click(screen.getByRole("button", { name: "Write Report" }));
    await waitFor(() => {
      expect(screen.getByText("Incident was not found")).toBeDefined();
    });
    expect(screen.getByRole("alert").textContent).toBe("Incident was not found");
    expect((screen.getByRole("button", { name: "Write Report" }) as HTMLButtonElement).disabled).toBe(false);
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
