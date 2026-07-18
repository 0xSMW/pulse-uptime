// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import type { StatusPageConfigDocument } from "@/lib/status-page/schema";

import { SettingsDirtyProvider, useSettingsDirty } from "./settings-dirty";
import {
  documentsEqual,
  mergeStatusPageDrafts,
  STATUS_PAGE_FIELDS,
  StatusPageSettings,
  toDocument,
  uploadValidationError,
} from "./status-page-settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const IMAGE_ID = "33333333-3333-4333-8333-333333333333";

function baseConfig(overrides: Partial<StatusPageConfigDocument> = {}): StatusPageConfigDocument {
  return {
    name: "System Status",
    layout: "vertical",
    theme: "system",
    logoLightImageId: null,
    logoDarkImageId: null,
    faviconImageId: null,
    homepageUrl: null,
    contactUrl: null,
    navLinks: [],
    googleTagId: null,
    customCss: null,
    customHead: null,
    announcementEnabled: false,
    announcementMarkdown: null,
    historyDays: 90,
    uptimeDecimals: 2,
    unknownAsOperational: false,
    minIncidentSeconds: 0,
    timezone: null,
    ...overrides,
  };
}

function DirtyReader() {
  const context = useSettingsDirty();
  return <span data-testid="dirty">{String(context?.dirty ?? false)}</span>;
}

function renderSettings(overrides: Partial<StatusPageConfigDocument> = {}, etag = '"1"') {
  return render(
    <SettingsDirtyProvider>
      <DirtyReader />
      <StatusPageSettings data={{ config: baseConfig(overrides), etag }} />
    </SettingsDirtyProvider>,
  );
}

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.etag ? { ETag: init.etag } : {},
  });
}

describe("mergeStatusPageDrafts", () => {
  const base = baseConfig();

  it("keeps local edits and adopts unrelated server changes", () => {
    const local = baseConfig({ name: "Acme Status" });
    const server = baseConfig({ historyDays: 30, contactUrl: "mailto:ops@acme.dev" });
    const merged = mergeStatusPageDrafts(base, local, server);
    expect(merged.name).toBe("Acme Status");
    expect(merged.historyDays).toBe(30);
    expect(merged.contactUrl).toBe("mailto:ops@acme.dev");
  });

  it("prefers the local value when both sides changed the same field", () => {
    const local = baseConfig({ name: "Acme Status" });
    const server = baseConfig({ name: "Server Status" });
    expect(mergeStatusPageDrafts(base, local, server).name).toBe("Acme Status");
  });

  it("treats navLinks as a whole-field merge", () => {
    const local = baseConfig({ navLinks: [{ label: "Docs", url: "https://acme.dev/docs" }] });
    const server = baseConfig({ navLinks: [{ label: "Blog", url: "https://acme.dev/blog" }] });
    expect(mergeStatusPageDrafts(base, local, server).navLinks).toEqual(local.navLinks);
  });
});

describe("StatusPageSettings save model", () => {
  it("shows one sticky save bar only when dirty and marks the shell dirty", () => {
    renderSettings();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByTestId("dirty").textContent).toBe("false");

    fireEvent.change(screen.getByLabelText("Page name"), { target: { value: "Acme Status" } });
    // The visible bar plus its always-mounted sr-only live-region announcer.
    expect(screen.getAllByText("Unsaved changes")).toHaveLength(2);
    expect(screen.getByTestId("dirty").textContent).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect((screen.getByLabelText("Page name") as HTMLInputElement).value).toBe("System Status");
    expect(screen.getByTestId("dirty").textContent).toBe("false");
    // The bar unmounted; focus lands on the always-mounted status region.
    expect(document.activeElement?.textContent).toBe("Changes discarded");
  });

  it("saves the whole document in a single PUT with If-Match", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: baseConfig({ name: "Acme Status" }) }, { etag: '"2"' }));
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    fireEvent.change(screen.getByLabelText("Page name"), { target: { value: "Acme Status" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Status page settings saved")).toBeDefined();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/status-page-config");
    expect(init.method).toBe("PUT");
    expect(init.headers["If-Match"]).toBe('"1"');
    // The config PUT route requires a UUID Idempotency-Key (executeIdempotent);
    // omitting it makes every Settings -> Status page save fail.
    expect(init.headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([...STATUS_PAGE_FIELDS].sort());
    expect(payload.name).toBe("Acme Status");
    expect(payload.historyDays).toBe(90);
    // Saved: the bar disappears and the shell is clean again.
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    // Focus moved off the unmounted Save button to the status region.
    expect(document.activeElement?.textContent).toBe("Status page settings saved");
  });

  it("recovers from a 412 by merging and preserving local edits", async () => {
    const serverDocument = baseConfig({ contactUrl: "mailto:ops@acme.dev" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "conflict" } }, { status: 412 }))
      .mockResolvedValueOnce(jsonResponse({ data: serverDocument }, { etag: '"7"' }))
      .mockResolvedValueOnce(jsonResponse({ data: serverDocument }, { etag: '"8"' }));
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    fireEvent.change(screen.getByLabelText("Page name"), { target: { value: "Acme Status" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Settings changed elsewhere — your edits are preserved, review and save again")).toBeDefined();
    });
    // Local edit preserved, server-side change adopted, still dirty.
    expect((screen.getByLabelText("Page name") as HTMLInputElement).value).toBe("Acme Status");
    expect((screen.getByLabelText("Contact URL") as HTMLInputElement).value).toBe("mailto:ops@acme.dev");
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0);
    // The conflict notice reads as an alert, not muted success text.
    expect(screen.getByRole("alert").textContent).toContain("changed elsewhere");

    // The retry carries the refreshed ETag.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    const [, retryInit] = fetchMock.mock.calls[2]!;
    expect(retryInit.method).toBe("PUT");
    expect(retryInit.headers["If-Match"]).toBe('"7"');
  });
});

describe("StatusPageSettings navigation links", () => {
  it("caps the repeater at 8 rows", () => {
    const links = Array.from({ length: 8 }, (_, index) => ({
      label: `Link ${index + 1}`,
      url: `https://acme.dev/${index + 1}`,
    }));
    renderSettings({ navLinks: links });
    expect(screen.getAllByLabelText(/Link \d+ label/)).toHaveLength(8);
    expect((screen.getByRole("button", { name: "Add Link" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds and removes rows below the cap without an instant validation alert", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Add Link" }));
    expect(screen.getByLabelText("Link 1 label")).toBeDefined();
    // A just-added empty row must not fire an instant alert.
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Link 1 label"), { target: { value: "Docs" } });
    // Still quiet while typing; validation waits for a save attempt.
    expect(screen.queryByText("Every link needs a label and a URL")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove link 1" }));
    expect(screen.queryByLabelText("Link 1 label")).toBeNull();
  });

  it("surfaces link validation only on a save attempt and blocks the PUT", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Add Link" }));
    fireEvent.change(screen.getByLabelText("Link 1 label"), { target: { value: "Docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Every link needs a label and a URL")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    // Editing the links clears the save-attempt error.
    fireEvent.change(screen.getByLabelText("Link 1 URL"), { target: { value: "https://acme.dev/docs" } });
    expect(screen.queryByText("Every link needs a label and a URL")).toBeNull();
  });

  it("drops fully-empty rows on save instead of failing validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: baseConfig({ name: "Acme Status" }) }, { etag: '"2"' }));
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();
    fireEvent.change(screen.getByLabelText("Page name"), { target: { value: "Acme Status" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByText("Status page settings saved")).toBeDefined();
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse(init.body as string) as { navLinks: unknown[] };
    expect(payload.navLinks).toEqual([]);
  });
});

describe("StatusPageSettings uploads", () => {
  it("uploads pre-save and commits only the returned id via the draft", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { id: IMAGE_ID } }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ data: baseConfig({ logoLightImageId: IMAGE_ID }) }, { etag: '"2"' }));
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    const file = new File(["png-bytes"], "logo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Logo (light theme)"), { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText("Ready — save to apply")).toBeDefined();
    });
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0]!;
    expect(uploadUrl).toBe("/api/v1/images");
    expect(uploadInit.method).toBe("POST");
    expect((uploadInit.body as FormData).get("kind")).toBe("logo-light");

    // The reference only commits through the page-level PUT.
    expect(screen.getAllByText("Unsaved changes").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByText("Status page settings saved")).toBeDefined();
    });
    const [, putInit] = fetchMock.mock.calls[1]!;
    const payload = JSON.parse(putInit.body as string) as Record<string, unknown>;
    expect(payload.logoLightImageId).toBe(IMAGE_ID);
  });

  it("surfaces upload failures inline without dirtying the draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: "favicon images must be at most 32 KB" } }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    const file = new File(["big"], "favicon.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Favicon"), { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText("favicon images must be at most 32 KB")).toBeDefined();
    });
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("rejects wrong types and oversized files before any network round-trip", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    fireEvent.change(screen.getByLabelText("Logo (light theme)"), {
      target: { files: [new File(["plain"], "notes.txt", { type: "text/plain" })] },
    });
    expect(screen.getByText("Use a PNG, JPEG, SVG, or WebP image.")).toBeDefined();

    const oversized = new File([new Uint8Array(33 * 1024)], "favicon.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Favicon"), { target: { files: [oversized] } });
    expect(screen.getByText("Favicon files must be at most 32 KB.")).toBeDefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("labels persisted images as saved and previews favicons via the image route", () => {
    const faviconId = "44444444-4444-4444-8444-444444444444";
    const { container } = renderSettings({ logoLightImageId: IMAGE_ID, faviconImageId: faviconId });
    expect(screen.getByText("Current logo — saved")).toBeDefined();
    expect(screen.getByText("Current favicon — saved")).toBeDefined();
    const sources = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(sources).toContain(`/api/v1/images/${faviconId}`);
    // Nothing is pending on a fresh load.
    expect(screen.queryByText("Ready — save to apply")).toBeNull();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });
});

describe("uploadValidationError", () => {
  it("mirrors the server type allowlists and byte caps", () => {
    const png = (bytes: number) => new File([new Uint8Array(bytes)], "a.png", { type: "image/png" });
    expect(uploadValidationError("logo-light", png(512 * 1024))).toBe("");
    expect(uploadValidationError("logo-light", png(512 * 1024 + 1))).toBe("Images must be at most 512 KB.");
    expect(uploadValidationError("favicon", png(32 * 1024))).toBe("");
    expect(uploadValidationError("favicon", png(32 * 1024 + 1))).toBe("Favicon files must be at most 32 KB.");
    expect(uploadValidationError("logo-dark", new File(["x"], "a.gif", { type: "image/gif" })))
      .toBe("Use a PNG, JPEG, SVG, or WebP image.");
    expect(uploadValidationError("favicon", new File(["x"], "a.ico", { type: "image/vnd.microsoft.icon" }))).toBe("");
    expect(uploadValidationError("favicon", new File(["x"], "a.webp", { type: "image/webp" })))
      .toBe("Use a PNG, ICO, or SVG file.");
  });
});

describe("document helpers", () => {
  it("compares and projects the full field list", () => {
    const document = baseConfig();
    expect(documentsEqual(document, baseConfig())).toBe(true);
    expect(documentsEqual(document, baseConfig({ uptimeDecimals: 3 }))).toBe(false);
    expect(Object.keys(toDocument(document)).sort()).toEqual([...STATUS_PAGE_FIELDS].sort());
  });
});
