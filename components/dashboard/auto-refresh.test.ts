import { describe, expect, it } from "vitest";

import { isLiveManagedPath, MIN_REFRESH_GAP_MS, shouldAutoRefresh } from "./auto-refresh";

describe("shouldAutoRefresh", () => {
  it("refreshes when visible and outside the throttle window", () => {
    expect(shouldAutoRefresh("visible", MIN_REFRESH_GAP_MS, 0)).toBe(true);
    expect(shouldAutoRefresh("visible", MIN_REFRESH_GAP_MS * 5, 0)).toBe(true);
  });

  it("never refreshes a hidden tab", () => {
    expect(shouldAutoRefresh("hidden", MIN_REFRESH_GAP_MS * 5, 0)).toBe(false);
  });

  it("throttles refreshes closer together than the minimum gap", () => {
    expect(shouldAutoRefresh("visible", MIN_REFRESH_GAP_MS - 1, 0)).toBe(false);
  });
});

describe("isLiveManagedPath", () => {
  it("stands down on a monitor detail page, which runs its own live poll", () => {
    expect(isLiveManagedPath("/monitors/abc")).toBe(true);
    expect(isLiveManagedPath("/monitors/some-id-123")).toBe(true);
  });

  it("stays active on other dashboard pages", () => {
    expect(isLiveManagedPath("/")).toBe(false);
    expect(isLiveManagedPath("/monitors")).toBe(false);
    expect(isLiveManagedPath("/monitors/abc/edit")).toBe(false);
    expect(isLiveManagedPath("/incidents")).toBe(false);
  });
});
