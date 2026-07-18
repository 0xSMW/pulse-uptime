import { describe, expect, it, vi } from "vitest";

import { navigateFromMonitorRow } from "./monitor-table";

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
