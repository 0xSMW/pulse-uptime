import { describe, expect, it, vi } from "vitest";

import { HOVER_PREFETCH_DELAY_MS, isPlainLeftClick, navigateFromMonitorRow, shouldPrefetchMonitor } from "./monitor-table";

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

describe("shouldPrefetchMonitor", () => {
  it("allows the first prefetch for a monitor id and records it", () => {
    const prefetched = new Set<string>();

    const allowed = shouldPrefetchMonitor("mon-1", prefetched);

    expect(allowed).toBe(true);
    expect(prefetched.has("mon-1")).toBe(true);
  });

  it("skips repeat prefetches for an id already seen this lifetime", () => {
    const prefetched = new Set<string>(["mon-1"]);

    const allowed = shouldPrefetchMonitor("mon-1", prefetched);

    expect(allowed).toBe(false);
    expect(prefetched.size).toBe(1);
  });

  it("tracks multiple ids independently", () => {
    const prefetched = new Set<string>();

    expect(shouldPrefetchMonitor("mon-1", prefetched)).toBe(true);
    expect(shouldPrefetchMonitor("mon-2", prefetched)).toBe(true);
    expect(shouldPrefetchMonitor("mon-1", prefetched)).toBe(false);
    expect(prefetched).toEqual(new Set(["mon-1", "mon-2"]));
  });
});

describe("HOVER_PREFETCH_DELAY_MS", () => {
  it("is a short, non-zero hover-intent delay", () => {
    expect(HOVER_PREFETCH_DELAY_MS).toBeGreaterThan(0);
    expect(HOVER_PREFETCH_DELAY_MS).toBeLessThanOrEqual(250);
  });
});
