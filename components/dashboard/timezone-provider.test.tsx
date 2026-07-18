import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  TimezoneProvider,
  useTimezone,
} from "./timezone-provider";

function Probe() {
  const { timezone, resolvedTimeZone } = useTimezone();
  return <span>{`${timezone}|${resolvedTimeZone}`}</span>;
}

describe("TimezoneProvider", () => {
  it("defaults to the device time zone, rendering UTC on the server", () => {
    expect(DEFAULT_TIMEZONE).toBe("system");
    const html = renderToStaticMarkup(
      <TimezoneProvider>
        <Probe />
      </TimezoneProvider>,
    );
    expect(html).toContain("system|UTC");
  });

  it("honors an explicit default", () => {
    const html = renderToStaticMarkup(
      <TimezoneProvider defaultTimezone="Asia/Bangkok">
        <Probe />
      </TimezoneProvider>,
    );
    expect(html).toContain("Asia/Bangkok|Asia/Bangkok");
  });

  it("validates IANA zone names", () => {
    expect(isValidTimeZone("Asia/Bangkok")).toBe(true);
    expect(isValidTimeZone("system")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});
