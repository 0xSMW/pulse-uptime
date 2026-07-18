// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GuardedLink, SettingsDirtyProvider, useDirtyGuard } from "./settings-dirty";

function DirtyProbe({ dirty = true }: { dirty?: boolean }) {
  useDirtyGuard("probe", dirty);
  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GuardedLink", () => {
  it("confirms before navigating while the shell is dirty", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
        <GuardedLink href="/incidents/reports">Manage status reports</GuardedLink>
      </SettingsDirtyProvider>,
    );
    const link = screen.getByRole("link", { name: "Manage status reports" });
    const click = fireEvent.click(link);
    expect(confirmSpy).toHaveBeenCalledWith("Discard unsaved changes?");
    // Declining the confirm cancels the navigation.
    expect(click).toBe(false);
  });

  it("navigates without a prompt when clean", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    render(
      <SettingsDirtyProvider>
        <GuardedLink href="/status">View status page</GuardedLink>
      </SettingsDirtyProvider>,
    );
    const click = fireEvent.click(screen.getByRole("link", { name: "View status page" }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(click).toBe(true);
  });

  it("proceeds when the user confirms the discard", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
        <GuardedLink href="/status">View status page</GuardedLink>
      </SettingsDirtyProvider>,
    );
    const click = fireEvent.click(screen.getByRole("link", { name: "View status page" }));
    expect(click).toBe(true);
  });
});

describe("SettingsDirtyProvider beforeunload", () => {
  it("registers beforeunload only while dirty and removes it on clean", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { rerender } = render(
      <SettingsDirtyProvider>
        <DirtyProbe dirty={false} />
      </SettingsDirtyProvider>,
    );
    expect(addSpy.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(0);

    rerender(
      <SettingsDirtyProvider>
        <DirtyProbe dirty />
      </SettingsDirtyProvider>,
    );
    expect(addSpy.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);

    rerender(
      <SettingsDirtyProvider>
        <DirtyProbe dirty={false} />
      </SettingsDirtyProvider>,
    );
    expect(removeSpy.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);
  });

  it("prompts the browser on unload while dirty", () => {
    render(
      <SettingsDirtyProvider>
        <DirtyProbe dirty />
      </SettingsDirtyProvider>,
    );
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
