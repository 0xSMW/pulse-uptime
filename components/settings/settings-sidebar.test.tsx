import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsSidebar } from "./settings-sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/general",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe("SettingsSidebar", () => {
  it("offers a way back to the app and links every section", () => {
    const html = renderToStaticMarkup(<SettingsSidebar />);
    expect(html).toContain("Back to app");
    expect(html).toContain('href="/settings/general"');
    expect(html).toContain('href="/settings/monitors"');
    expect(html).toContain('href="/settings/access"');
    expect(html).toContain('href="/settings/system"');
    expect(html).toContain('aria-label="Settings sections"');
  });

  it("marks only the active section as current", () => {
    const html = renderToStaticMarkup(<SettingsSidebar />);
    const currentMatches = html.match(/aria-current="page"/g) ?? [];
    expect(currentMatches).toHaveLength(1);
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/settings\/general"/);
  });
});
