// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, refresh: navigation.refresh }),
}));

// jsdom has no layout engine, so Radix Select's scroll-into-view and pointer
// capture calls are unimplemented; stub them so opening a Select in tests
// doesn't throw.
beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

import { TimezoneProvider } from "@/components/dashboard/timezone-provider";
import { ReportEditor, type ReportEditorMonitor } from "./report-editor";
import { isReportEditorDirty, setReportEditorDirty } from "./report-editor-dirty";
import type { ReportData } from "./report-status";

afterEach(() => {
  cleanup();
  setReportEditorDirty(false);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const monitors: ReportEditorMonitor[] = [
  { id: "api-prod", name: "API Production", group: "Core" },
  { id: "marketing", name: "Marketing site", group: null },
];

const report: ReportData = {
  id: "rep-1",
  type: "incident",
  title: "Elevated API error rates",
  startsAt: "2026-07-18T09:00:00.000Z",
  endsAt: null,
  publishedAt: null,
  resolvedAt: "2026-07-18T12:00:00.000Z",
  originIncidentId: null,
  currentStatus: "resolved",
  updates: [
    { id: "u2", status: "resolved", markdown: "All clear.", publishedAt: "2026-07-18T12:00:00.000Z", createdAt: "2026-07-18T12:00:00.000Z" },
    { id: "u1", status: "monitoring", markdown: "Watching recovery.", publishedAt: "2026-07-18T10:00:00.000Z", createdAt: "2026-07-18T10:00:00.000Z" },
  ],
  affected: [{ monitorId: "api-prod", monitorName: "API Production", groupName: "Core", impact: "down" }],
  createdAt: "2026-07-18T09:00:00.000Z",
  updatedAt: "2026-07-18T12:00:00.000Z",
};

function okEnvelope(data: unknown) {
  return new Response(JSON.stringify({ apiVersion: "v1", kind: "StatusReport", data }), { status: 200 });
}

function renderEditor(target: ReportData | null) {
  return render(
    <TimezoneProvider>
      <ReportEditor report={target} monitors={monitors} />
    </TimezoneProvider>,
  );
}

describe("ReportEditor create mode", () => {
  it("requires a title and an initial update before posting", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(null);
    fireEvent.click(screen.getByRole("button", { name: "Create Status Report" }));
    expect(screen.getByText("Enter a title")).toBeDefined();
    expect(screen.getByText("Write the first update")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hides the maintenance end field for incident reports", () => {
    renderEditor(null);
    expect(screen.getByLabelText("Starts at")).toBeDefined();
    expect(screen.queryByLabelText("Ends at")).toBeNull();
    expect(screen.getByText("You can use markdown.")).toBeDefined();
    expect(screen.getByLabelText("Save as draft")).toBeDefined();
  });

  it("creates the report and navigates to its editor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "rep-9" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(null);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "API outage" } });
    fireEvent.change(screen.getByLabelText("Initial update"), { target: { value: "We are investigating." } });
    fireEvent.click(screen.getByRole("button", { name: "Create Status Report" }));
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith("/incidents/reports/rep-9");
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/status-reports");
    const body = JSON.parse(String(init.body)) as { type: string; draft?: boolean; update: { markdown: string } };
    expect(body.type).toBe("incident");
    expect(body.draft).toBeUndefined();
    expect(body.update.markdown).toBe("We are investigating.");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeTruthy();
  });
});

describe("ReportEditor edit mode", () => {
  it("shows the maintenance end field for maintenance reports and locks type", () => {
    renderEditor({
      ...report,
      type: "maintenance",
      currentStatus: "in_progress",
      updates: [{ id: "u1", status: "in_progress", markdown: "Underway.", publishedAt: "2026-07-18T10:00:00.000Z" }],
      resolvedAt: null,
    });
    expect(screen.getByLabelText("Ends at")).toBeDefined();
    expect(screen.getByText("Type is locked after creation")).toBeDefined();
  });

  it("renders the timeline newest-first with a draft badge and group sections", () => {
    renderEditor(report);
    expect(screen.getByText("Draft")).toBeDefined();
    expect(screen.getByText("All clear.")).toBeDefined();
    expect(screen.getByText("Watching recovery.")).toBeDefined();
    expect(screen.getByText("Core")).toBeDefined();
    expect(screen.getByText("Ungrouped")).toBeDefined();
    expect(screen.getByLabelText("Impact for API Production")).toBeDefined();
  });

  it("warns before a backdate flips the report to Ongoing, then saves on confirm", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    const row = screen.getByText("All clear.").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Published at", { selector: "#edit-published-u2" }), {
      target: { value: "2026-07-17T09:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }));
    expect(
      screen.getByText("This moves the report back to Ongoing — it will reappear at the top of your status page."),
    ).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save Anyway" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1/updates/u2",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });

  it("saves without a warning when the state does not flip", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    const row = screen.getByText("Watching recovery.").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Update", { selector: "#edit-markdown-u1" }), {
      target: { value: "Recovery confirmed." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1/updates/u1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });

  it("surfaces LAST_UPDATE when deleting the only update", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "LAST_UPDATE", message: "A report must keep at least one update" } }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderEditor({
      ...report,
      updates: [{ id: "u1", status: "resolved", markdown: "All clear.", publishedAt: "2026-07-18T12:00:00.000Z" }],
    });
    const row = screen.getByText("All clear.").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(within(row).getByText("Delete update?")).toBeDefined();
    fireEvent.click(within(row).getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(
        screen.getByText("A report must keep at least one update — delete the report instead."),
      ).toBeDefined();
    });
  });

  it("requires confirmation, stating public visibility, before publishing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ ...report, publishedAt: "2026-07-18T13:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(
      screen.getByText("Publishing makes this report publicly visible on your status page."),
    ).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1/publish",
        expect.objectContaining({ method: "POST" }),
      );
      expect(screen.getByText("Report published")).toBeDefined();
    });
  });

  it("deletes the report after a two-step confirm and returns to the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    const header = screen.getByRole("heading", { name: "Edit status report" }).closest("header")!;
    fireEvent.click(within(header).getByRole("button", { name: "Delete" }));
    expect(within(header).getByText("Delete report?")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(header).getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith("/incidents/reports");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/status-reports/rep-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("posts a composer update scoped to the report", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    fireEvent.change(screen.getByLabelText("New update"), { target: { value: "Postmortem coming." } });
    fireEvent.click(screen.getByRole("button", { name: "Post Update" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1/updates",
        expect.objectContaining({ method: "POST" }),
      );
      expect(screen.getByText("Update posted")).toBeDefined();
    });
  });

  it("omits publishedAt from the PATCH when only the markdown changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    const row = screen.getByText("Watching recovery.").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Update", { selector: "#edit-markdown-u1" }), {
      target: { value: "Recovery confirmed." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.markdown).toBe("Recovery confirmed.");
    expect("publishedAt" in body).toBe(false);
  });

  it("omits status and markdown from the PATCH when only publishedAt changed (finding: an unchanged page-load status/markdown clobbers a concurrent edit)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    const row = screen.getByText("Watching recovery.").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    // Moves publishedAt later but still well before u2 (resolved) — no state
    // flip, so no confirmation gate to click through first.
    fireEvent.change(screen.getByLabelText("Published at", { selector: "#edit-published-u1" }), {
      target: { value: "2026-07-18T11:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Update" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1/updates/u1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect("status" in body).toBe(false);
    expect("markdown" in body).toBe(false);
    expect(typeof body.publishedAt).toBe("string");
  });

  it("omits affected from the PATCH when only the title changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Retitled report" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.title).toBe("Retitled report");
    expect("affected" in body).toBe(false);
  });

  it("omits startsAt/endsAt from the PATCH when only the title changed (finding: an untouched datetime-local value silently truncates seconds)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor({ ...report, type: "maintenance", endsAt: "2026-07-18T15:00:00.000Z" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Retitled report" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.title).toBe("Retitled report");
    expect("startsAt" in body).toBe(false);
    expect("endsAt" in body).toBe(false);
  });

  it("sends startsAt when the start time actually changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    fireEvent.change(screen.getByLabelText("Starts at"), { target: { value: "2026-07-10T08:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect("startsAt" in body).toBe(true);
    expect(typeof body.startsAt).toBe("string");
  });

  it("omits title from the PATCH when only affected changed (finding: an unchanged page-load title clobbers a concurrent title edit)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    fireEvent.click(screen.getByLabelText("Impact for Marketing site"));
    fireEvent.click(await screen.findByRole("option", { name: "Degraded" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect("title" in body).toBe(false);
    expect(body.affected).toBeDefined();
  });

  it("still sends the full affected replacement when the impact picker changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(report));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor(report);
    fireEvent.click(screen.getByLabelText("Impact for Marketing site"));
    fireEvent.click(await screen.findByRole("option", { name: "Degraded" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/status-reports/rep-1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { affected?: Array<{ monitorId: string; impact: string }> };
    expect(body.affected).toEqual(
      expect.arrayContaining([
        { monitorId: "api-prod", impact: "down" },
        { monitorId: "marketing", impact: "degraded" },
      ]),
    );
  });

  it("warns inside the delete confirm when removing the resolving update reopens the report", () => {
    renderEditor(report);
    const row = screen.getByText("All clear.").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(within(row).getByText("Delete update?")).toBeDefined();
    expect(
      within(row).getByText("This moves the report back to Ongoing — it will reappear at the top of your status page."),
    ).toBeDefined();
  });

  it("warns when the composer update is dated before the report start", () => {
    renderEditor(report);
    fireEvent.change(screen.getByLabelText("Published at"), { target: { value: "2026-07-01T08:00" } });
    expect(screen.getByText("This update is dated before the report's start time")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Published at"), { target: { value: "2026-07-19T08:00" } });
    expect(screen.queryByText("This update is dated before the report's start time")).toBeNull();
  });

  it("warns in the edit form when publishedAt predates the report start", () => {
    renderEditor(report);
    const row = screen.getByText("Watching recovery.").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Published at", { selector: "#edit-published-u1" }), {
      target: { value: "2026-07-01T08:00" },
    });
    expect(within(row).getByText("This update is dated before the report's start time")).toBeDefined();
  });
});

describe("ReportEditor unsaved-changes protection", () => {
  it("disables Save Changes until basics change, then tracks dirty state", () => {
    renderEditor(report);
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(isReportEditorDirty()).toBe(false);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Retitled report" } });
    expect(isReportEditorDirty()).toBe(true);
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: report.title } });
    expect(isReportEditorDirty()).toBe(false);
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tracks dirty state for the start time", () => {
    renderEditor(report);
    fireEvent.change(screen.getByLabelText("Starts at"), { target: { value: "2026-07-10T08:00" } });
    expect(isReportEditorDirty()).toBe(true);
  });

  it("tracks dirty state for composer text", () => {
    renderEditor(report);
    expect(isReportEditorDirty()).toBe(false);
    fireEvent.change(screen.getByLabelText("New update"), { target: { value: "Draft in progress" } });
    expect(isReportEditorDirty()).toBe(true);
    fireEvent.change(screen.getByLabelText("New update"), { target: { value: "" } });
    expect(isReportEditorDirty()).toBe(false);
  });

  it("tracks dirty state for an open update edit and clears on cancel", () => {
    renderEditor(report);
    const row = screen.getByText("Watching recovery.").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect(isReportEditorDirty()).toBe(false);
    fireEvent.change(screen.getByLabelText("Update", { selector: "#edit-markdown-u1" }), {
      target: { value: "Changed body." },
    });
    expect(isReportEditorDirty()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(isReportEditorDirty()).toBe(false);
  });

  it("registers a beforeunload guard while dirty", () => {
    renderEditor(report);
    const addSpy = vi.spyOn(window, "addEventListener");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Retitled report" } });
    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    const removeSpy = vi.spyOn(window, "removeEventListener");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: report.title } });
    expect(removeSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });
});
