// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./confirm-dialog";

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
});

function renderDialog(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Discard unsaved changes?"
      description="Your changes will be lost."
      confirmLabel="Discard"
      cancelLabel="Keep Editing"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  it("does not open the native dialog while closed", () => {
    renderDialog({ open: false });
    expect(document.querySelector("dialog")?.open).toBe(false);
  });

  it("opens the native dialog and renders title/description when open", () => {
    renderDialog();
    expect(document.querySelector("dialog")?.open).toBe(true);
    expect(screen.getByText("Discard unsaved changes?")).toBeDefined();
    expect(screen.getByText("Your changes will be lost.")).toBeDefined();
  });

  it("focuses the cancel button on open", () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep Editing" }));
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when the cancel button is clicked", () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("maps Esc (native cancel event) to onCancel and suppresses the dialog's own close", () => {
    const { onCancel } = renderDialog();
    const dialog = document.querySelector("dialog")!;
    const event = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(event);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("maps a backdrop click to onCancel", () => {
    const { onCancel } = renderDialog();
    const dialog = document.querySelector("dialog")!;
    // A click landing on the <dialog> element itself (not inside the form
    // content) is a backdrop click.
    fireEvent.click(dialog);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not treat a click on the dialog content as a backdrop click", () => {
    const { onCancel } = renderDialog();
    fireEvent.click(screen.getByText("Discard unsaved changes?"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("styles the confirm button as destructive when requested", () => {
    renderDialog({ destructive: true });
    expect(screen.getByRole("button", { name: "Discard" }).className).toContain("error-solid");
  });

  it("uses the primary button style by default", () => {
    renderDialog({ destructive: false });
    const button = screen.getByRole("button", { name: "Discard" });
    expect(button.className).not.toContain("error-solid");
  });
});
