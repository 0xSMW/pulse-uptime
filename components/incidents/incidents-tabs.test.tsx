import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { IncidentsTabs } from "./incidents-tabs";

const navigation = vi.hoisted(() => ({ pathname: "/incidents" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

function activeTab(html: string): string | null {
  const match = html.match(/aria-current="page"[^>]*>([^<]+)</);
  return match?.[1] ?? null;
}

describe("IncidentsTabs", () => {
  it("renders both tab links", () => {
    navigation.pathname = "/incidents";
    const html = renderToStaticMarkup(<IncidentsTabs />);
    expect(html).toContain('href="/incidents/reports"');
    expect(html).toContain('href="/incidents"');
    expect(html).toContain("Reports");
    expect(html).toContain("Outage history");
  });

  it("marks Outage history active on /incidents and detail pages", () => {
    navigation.pathname = "/incidents";
    expect(activeTab(renderToStaticMarkup(<IncidentsTabs />))).toBe("Outage history");
    navigation.pathname = "/incidents/abc-123";
    expect(activeTab(renderToStaticMarkup(<IncidentsTabs />))).toBe("Outage history");
  });

  it("marks Reports active across the reports subtree", () => {
    navigation.pathname = "/incidents/reports";
    expect(activeTab(renderToStaticMarkup(<IncidentsTabs />))).toBe("Reports");
    navigation.pathname = "/incidents/reports/new";
    expect(activeTab(renderToStaticMarkup(<IncidentsTabs />))).toBe("Reports");
    navigation.pathname = "/incidents/reports/rep-1";
    expect(activeTab(renderToStaticMarkup(<IncidentsTabs />))).toBe("Reports");
  });
});
