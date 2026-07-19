// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNavigationGuard, type NavigationGuardOptions } from "./use-navigation-guard";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

const OPTIONS: NavigationGuardOptions = {
  title: "Discard unsaved changes?",
  description: "Your changes will be lost.",
  confirmLabel: "Discard",
  cancelLabel: "Keep Editing",
};

function Harness({ dirty }: { dirty: boolean }) {
  return <>{useNavigationGuard(dirty, OPTIONS)}</>;
}

const originalLocation = window.location;

// jsdom does not implement HTMLDialogElement.showModal()/close() (both are
// undefined, not even throwing stubs). Polyfill the minimal behavior that
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
  Object.defineProperty(window, "location", { value: originalLocation, writable: true, configurable: true });
});

function isDialogOpen(): boolean {
  return document.querySelector("dialog")?.open ?? false;
}

describe("useNavigationGuard beforeunload", () => {
  it("registers beforeunload while dirty and removes it when clean", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { rerender } = render(<Harness dirty={false} />);
    expect(addSpy.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(0);

    rerender(<Harness dirty />);
    expect(addSpy.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);

    rerender(<Harness dirty={false} />);
    expect(removeSpy.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);
  });

  it("prevents the default unload while dirty", () => {
    render(<Harness dirty />);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not prevent unload while clean", () => {
    render(<Harness dirty={false} />);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("useNavigationGuard history (popstate)", () => {
  it("re-pushes the sentinel synchronously, before the dialog opens", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    render(<Harness dirty />);
    // The hook pushes a sentinel entry on mount.
    expect(pushStateSpy).toHaveBeenCalledTimes(1);

    fireEvent(window, new PopStateEvent("popstate"));

    // Restored before the dialog is shown, not after a confirm/cancel.
    expect(pushStateSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Discard unsaved changes?")).toBeDefined();
    expect(isDialogOpen()).toBe(true);
  });

  it("Keep Editing closes the dialog and leaves the restored sentinel alone", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    render(<Harness dirty />);
    fireEvent(window, new PopStateEvent("popstate"));
    expect(pushStateSpy).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));

    expect(isDialogOpen()).toBe(false);
    expect(pushStateSpy).toHaveBeenCalledTimes(2);
  });

  it("Discard calls history.go(-2) to complete the exit past the sentinel and the landed-on entry", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    // jsdom has too little synthetic history for a real -2 traversal (it
    // logs "Not implemented: navigation to another Document"); stub it so
    // the test asserts the call without depending on jsdom's navigation.
    const goSpy = vi.spyOn(window.history, "go").mockImplementation(() => {});
    render(<Harness dirty />);
    fireEvent(window, new PopStateEvent("popstate"));

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(goSpy).toHaveBeenCalledWith(-2);
    expect(isDialogOpen()).toBe(false);
    // No further pushState beyond the sentinel already restored.
    expect(pushStateSpy).toHaveBeenCalledTimes(2);
  });

  it("does not push a sentinel or open the dialog while clean", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    render(<Harness dirty={false} />);

    fireEvent(window, new PopStateEvent("popstate"));

    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(isDialogOpen()).toBe(false);
  });
});

describe("useNavigationGuard link clicks", () => {
  function renderLink(attrs: Record<string, string> = {}) {
    const anchor = document.createElement("a");
    anchor.href = attrs.href ?? "/somewhere";
    for (const [key, value] of Object.entries(attrs)) anchor.setAttribute(key, value);
    document.body.appendChild(anchor);
    return anchor;
  }

  it("prevents the click and opens the dialog while dirty", () => {
    render(<Harness dirty />);
    const anchor = renderLink();
    const result = fireEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(result).toBe(false);
    expect(isDialogOpen()).toBe(true);
    expect(screen.getByText("Discard unsaved changes?")).toBeDefined();
    anchor.remove();
  });

  it("navigates through the router for a same-origin href on Discard", () => {
    render(<Harness dirty />);
    const anchor = renderLink({ href: "/somewhere" });
    fireEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(navigation.push).toHaveBeenCalledWith("/somewhere");
    expect(isDialogOpen()).toBe(false);
    anchor.remove();
  });

  it("navigates via window.location.assign for a cross-origin href on Discard", () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    });
    render(<Harness dirty />);
    const anchor = renderLink({ href: "https://example.com/foo" });
    fireEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(assign).toHaveBeenCalledWith("https://example.com/foo");
    expect(navigation.push).not.toHaveBeenCalled();
    anchor.remove();
  });

  it("Keep Editing closes the dialog without navigating", () => {
    render(<Harness dirty />);
    const anchor = renderLink();
    fireEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));

    expect(navigation.push).not.toHaveBeenCalled();
    expect(isDialogOpen()).toBe(false);
    anchor.remove();
  });

  it("does not open the dialog while clean", () => {
    render(<Harness dirty={false} />);
    const anchor = renderLink();
    const result = fireEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(result).toBe(true);
    expect(isDialogOpen()).toBe(false);
    anchor.remove();
  });

  it("ignores same-page hash links", () => {
    render(<Harness dirty />);
    const anchor = renderLink({ href: "#section" });
    fireEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(isDialogOpen()).toBe(false);
    anchor.remove();
  });

  it("ignores target=_blank links", () => {
    render(<Harness dirty />);
    const anchor = renderLink({ target: "_blank" });
    fireEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(isDialogOpen()).toBe(false);
    anchor.remove();
  });

  it("ignores download links", () => {
    render(<Harness dirty />);
    const anchor = renderLink({ download: "" });
    fireEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(isDialogOpen()).toBe(false);
    anchor.remove();
  });

  it("ignores modified clicks (e.g. ctrl/cmd-click to open in a new tab)", () => {
    render(<Harness dirty />);
    const anchor = renderLink();
    fireEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));

    expect(isDialogOpen()).toBe(false);
    anchor.remove();
  });

  it("removes the click listener when it becomes clean", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { rerender } = render(<Harness dirty />);
    rerender(<Harness dirty={false} />);
    expect(removeSpy.mock.calls.some(([type, , options]) => type === "click" && options === true)).toBe(true);
  });
});
