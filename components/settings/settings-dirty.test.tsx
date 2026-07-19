// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DISCARD_PROMPT, GuardedLink, SettingsDirtyProvider, useDirtyGuard } from "./settings-dirty";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

function DirtyProbe({ dirty = true }: { dirty?: boolean }) {
  useDirtyGuard("probe", dirty);
  return null;
}

// jsdom does not implement HTMLDialogElement.showModal()/close() (both are
// undefined, not even throwing stubs). Polyfill the minimal behavior
// ConfirmDialog depends on: toggling the `open` attribute/property, which
// jsdom's generic boolean-attribute reflection already handles once set.
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
  navigation.push.mockClear();
});

function isDialogOpen(): boolean {
  return document.querySelector("dialog")?.open ?? false;
}

describe("GuardedLink", () => {
  it("prevents the click and opens the discard dialog while the shell is dirty", () => {
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
        <GuardedLink href="/incidents/reports">Manage status reports</GuardedLink>
      </SettingsDirtyProvider>,
    );
    const link = screen.getByRole("link", { name: "Manage status reports" });
    const click = fireEvent.click(link);
    // Declining the confirm cancels the navigation.
    expect(click).toBe(false);
    expect(isDialogOpen()).toBe(true);
    expect(screen.getByRole("heading", { name: "Discard unsaved changes?" })).toBeDefined();
  });

  it("navigates without a prompt when clean", () => {
    render(
      <SettingsDirtyProvider>
        <GuardedLink href="/status">View status page</GuardedLink>
      </SettingsDirtyProvider>,
    );
    const click = fireEvent.click(screen.getByRole("link", { name: "View status page" }));
    expect(isDialogOpen()).toBe(false);
    expect(click).toBe(true);
  });

  it("navigates through the router after confirming the discard", () => {
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
        <GuardedLink href="/status">View status page</GuardedLink>
      </SettingsDirtyProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "View status page" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(navigation.push).toHaveBeenCalledWith("/status");
    expect(isDialogOpen()).toBe(false);
  });
});

describe("SettingsDirtyProvider global navigation guard", () => {
  it("opens exactly one dialog on a GuardedLink click while dirty (no double-prompt)", () => {
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
        <GuardedLink href="/incidents/reports">Manage status reports</GuardedLink>
      </SettingsDirtyProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Manage status reports" }));
    expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
  });

  it("opens the dialog on a plain, unwrapped link click while dirty (TopNav/logo-style links)", () => {
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- intentionally a plain <a>, not next/link, to prove the guard covers any document link (e.g. the TopNav logo) */}
        <a href="/">Pulse</a>
      </SettingsDirtyProvider>,
    );
    const click = fireEvent.click(screen.getByRole("link", { name: "Pulse" }));
    expect(isDialogOpen()).toBe(true);
    expect(click).toBe(false);
  });

  it("re-pushes the sentinel and opens the dialog on browser Back/Forward (popstate) while dirty", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
      </SettingsDirtyProvider>,
    );
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
    fireEvent(window, new PopStateEvent("popstate"));
    expect(pushStateSpy).toHaveBeenCalledTimes(2);
    expect(isDialogOpen()).toBe(true);
    expect(screen.getByRole("heading", { name: "Discard unsaved changes?" })).toBeDefined();
  });

  it("does not open the dialog on popstate when nothing is dirty", () => {
    render(<SettingsDirtyProvider>{null}</SettingsDirtyProvider>);
    fireEvent(window, new PopStateEvent("popstate"));
    expect(isDialogOpen()).toBe(false);
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

describe("DISCARD_PROMPT copy", () => {
  it("is used as the dialog description", () => {
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
      </SettingsDirtyProvider>,
    );
    fireEvent(window, new PopStateEvent("popstate"));
    expect(screen.getByText(DISCARD_PROMPT, { selector: "p" })).toBeDefined();
  });
});
