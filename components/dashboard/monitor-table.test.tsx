import { describe, expect, it, vi } from "vitest";

import { isPlainLeftClick, navigateFromMonitorRow } from "./monitor-table";

function targetWithClosest(result: Element | null): EventTarget {
  return { closest: vi.fn(() => result) } as unknown as EventTarget;
}

describe("navigateFromMonitorRow", () => {
  it("navigates non-interactive row clicks to the encoded detail route", () => {
    const navigate = vi.fn();

    const handled = navigateFromMonitorRow(targetWithClosest(null), "public api", navigate);

    expect(handled).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/monitors/public%20api");
  });

  it("does not hijack nested interactive controls", () => {
    const navigate = vi.fn();

    const handled = navigateFromMonitorRow(targetWithClosest({} as Element), "public-api", navigate);

    expect(handled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("isPlainLeftClick", () => {
  const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };

  it("accepts an unmodified left click", () => {
    expect(isPlainLeftClick(plain)).toBe(true);
  });

  it.each([
    ["middle button", { ...plain, button: 1 }],
    ["cmd", { ...plain, metaKey: true }],
    ["ctrl", { ...plain, ctrlKey: true }],
    ["shift", { ...plain, shiftKey: true }],
    ["alt", { ...plain, altKey: true }],
    ["defaultPrevented", { ...plain, defaultPrevented: true }],
  ])("rejects %s clicks so they never enter the pending state", (_label, event) => {
    expect(isPlainLeftClick(event)).toBe(false);
  });
});
