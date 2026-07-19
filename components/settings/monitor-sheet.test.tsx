// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveMonitorName, MonitorSheet, type EditableMonitor } from "./monitor-sheet";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// jsdom does not implement HTMLDialogElement.showModal()/close() (both are
// undefined, not even throwing stubs). Polyfill the minimal behavior the
// Sheet depends on: toggling the `open` attribute/property, which jsdom's
// generic boolean-attribute reflection already handles once set.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const existingMonitor: EditableMonitor = {
  id: "api-prod",
  name: "API Production",
  url: "https://api.example.com/health",
  enabled: true,
  groupId: null,
  group: null,
  method: "GET",
  intervalMinutes: 1,
  timeoutMs: 8000,
  expectedStatusMin: 200,
  expectedStatusMax: 399,
  failureThreshold: 2,
  recoveryThreshold: 2,
  recipients: [],
};

function renderSheet(props: Partial<React.ComponentProps<typeof MonitorSheet>> = {}) {
  return render(
    <MonitorSheet
      open
      monitor={null}
      groups={[]}
      onGroupCreated={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

function urlInput(): HTMLInputElement {
  return screen.getByLabelText("URL") as HTMLInputElement;
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("Name") as HTMLInputElement;
}

describe("deriveMonitorName", () => {
  it("derives a cleaned hostname from the endpoint", () => {
    expect(deriveMonitorName("https://api.acme.dev/health")).toBe("api.acme.dev");
    expect(deriveMonitorName("https://www.acme.dev")).toBe("acme.dev");
    expect(deriveMonitorName("api.acme.dev/health")).toBe("api.acme.dev");
  });

  it("returns an empty name when no hostname can be derived", () => {
    expect(deriveMonitorName("")).toBe("");
    expect(deriveMonitorName("not a url")).toBe("");
  });
});

describe("MonitorSheet", () => {
  it("puts the URL field before the name field", () => {
    renderSheet();
    const position = urlInput().compareDocumentPosition(nameInput());
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("derives the name from the URL until the name is edited manually", () => {
    renderSheet();
    fireEvent.change(urlInput(), { target: { value: "https://www.api.acme.dev/health" } });
    expect(nameInput().value).toBe("api.acme.dev");

    fireEvent.change(urlInput(), { target: { value: "https://status.acme.dev" } });
    expect(nameInput().value).toBe("status.acme.dev");

    fireEvent.change(nameInput(), { target: { value: "Custom Name" } });
    fireEvent.change(urlInput(), { target: { value: "https://other.example.dev" } });
    expect(nameInput().value).toBe("Custom Name");
  });

  it("never rewrites the name of an existing monitor", () => {
    renderSheet({ monitor: existingMonitor });
    fireEvent.change(urlInput(), { target: { value: "https://changed.example.com/health" } });
    expect(nameInput().value).toBe("API Production");
  });

  it("offers supplied groups through the group control", () => {
    renderSheet({ groups: [{ id: "production", name: "Production", monitorCount: 1 }] });
    expect(screen.getByRole("combobox", { name: "Group" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Create Group" })).toBeNull();
  });

  it("falls back to group creation when no groups exist", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: "Create Group" })).toBeDefined();
  });
});
