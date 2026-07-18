// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/account",
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

import { SettingsDirtyProvider, useDirtyGuard } from "./settings-dirty";
import { SettingsSidebar } from "./settings-sidebar";

function DirtyProbe() {
  useDirtyGuard("probe", true);
  return null;
}

afterEach(() => {
  cleanup();
  push.mockClear();
  vi.restoreAllMocks();
});

describe("SettingsSidebar", () => {
  it("offers a way back to the app and links every section", () => {
    const html = renderToStaticMarkup(<SettingsSidebar />);
    expect(html).toContain("Back to app");
    expect(html).toContain('href="/settings/account"');
    expect(html).toContain('href="/settings/security"');
    expect(html).toContain('href="/settings/status-page"');
    expect(html).toContain('href="/settings/notifications"');
    expect(html).toContain('href="/settings/monitors"');
    expect(html).toContain('href="/settings/access"');
    expect(html).toContain('href="/settings/system"');
    expect(html).toContain('aria-label="Settings sections"');
  });

  it("groups items under Account and Workspace section labels", () => {
    const html = renderToStaticMarkup(<SettingsSidebar />);
    expect(html).toContain(">Account</span>");
    expect(html).toContain(">Workspace</span>");
    expect(html.indexOf(">Account</span>")).toBeLessThan(html.indexOf(">Workspace</span>"));
  });

  it("marks only the active section as current", () => {
    const html = renderToStaticMarkup(<SettingsSidebar />);
    const currentMatches = html.match(/aria-current="page"/g) ?? [];
    expect(currentMatches).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*href="\/settings\/account"/);
  });

  it("leaves settings on Escape when nothing is dirty", () => {
    render(
      <SettingsDirtyProvider>
        <SettingsSidebar />
      </SettingsDirtyProvider>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(push).toHaveBeenCalledWith("/");
  });

  it("suppresses the Escape exit while a form is dirty and announces why", () => {
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
        <SettingsSidebar />
      </SettingsDirtyProvider>,
    );
    expect(screen.queryByText("Unsaved changes — save or discard before leaving")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved changes — save or discard before leaving")).toBeDefined();
  });

  it("confirms before sidebar navigation discards dirty state", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <SettingsDirtyProvider>
        <DirtyProbe />
        <SettingsSidebar />
      </SettingsDirtyProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Monitors" }));
    expect(confirmSpy).toHaveBeenCalledWith("Discard unsaved changes?");
    fireEvent.click(screen.getByRole("link", { name: "Back to app" }));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });

  it("does not confirm navigation when nothing is dirty", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <SettingsDirtyProvider>
        <SettingsSidebar />
      </SettingsDirtyProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Monitors" }));
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
