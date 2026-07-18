import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/components/dashboard/theme-provider";
import { TimezoneProvider } from "@/components/dashboard/timezone-provider";
import { GeneralSettings } from "./general-settings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function render(sender: string | null) {
  return renderToStaticMarkup(
    <ThemeProvider>
      <TimezoneProvider>
        <GeneralSettings data={{ defaultRecipients: ["ops@example.com"], sender }} />
      </TimezoneProvider>
    </ThemeProvider>,
  );
}

describe("GeneralSettings", () => {
  it("leads with appearance preferences", () => {
    const html = render(null);
    expect(html.indexOf("Appearance")).toBeLessThan(html.indexOf("Notifications"));
    expect(html).toContain("Theme");
    expect(html).toContain("account menu");
  });

  it("offers a time zone preference that follows the device by default", () => {
    const html = render(null);
    expect(html).toContain("Time zone");
    expect(html).toContain('aria-label="Time zone"');
    expect(html).toContain("Following your device");
  });

  it("renders the recipients form with save and test actions", () => {
    const html = render("Pulse <alerts@example.com>");
    expect(html).toContain("Default Recipients");
    expect(html).toContain("ops@example.com");
    expect(html).toContain("Save Recipients");
    expect(html).toContain("Send Test Email");
    expect(html).toContain("via Resend");
  });

  it("states when no sender is configured", () => {
    const html = render(null);
    expect(html).toContain("Email sender is not configured");
  });
});
