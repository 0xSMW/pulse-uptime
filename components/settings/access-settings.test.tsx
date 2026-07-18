import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TimezoneProvider } from "@/components/dashboard/timezone-provider";
import { AccessSettings, type AccessSettingsData } from "./access-settings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const data: AccessSettingsData = {
  tokens: [
    { id: "tok-1", name: "CI deploys", kind: "agent", detail: null, prefix: "pulse_live_a1b2", scopes: ["monitors:read", "config:write"], expiresAt: "2026-10-16T00:00:00.000Z", lastUsedAt: null },
    { id: "cli-1", name: "Stephen's MacBook", kind: "cli", detail: "darwin/arm64", prefix: "pulse_cli_z9y8", scopes: ["monitors:read"], expiresAt: "2026-08-16T00:00:00.000Z", lastUsedAt: null },
  ],
  origin: "https://pulse.example.com",
};

describe("AccessSettings", () => {
  it("renders agent tokens with revoke and CLI sessions as linked", () => {
    const html = renderToStaticMarkup(<TimezoneProvider><AccessSettings data={data} /></TimezoneProvider>);
    expect(html).toContain("CI deploys");
    expect(html).toContain("Agent token");
    expect(html).toContain(">Revoke</button>");
    expect(html).toContain("CLI session · darwin/arm64");
    expect(html).toContain("Linked session");
    expect(html).toContain("pulse_live_a1b2····");
    expect(html).toContain("config:write");
    expect(html).toContain("Oct 16, 2026");
  });

  it("renders the CLI section with the configured origin", () => {
    const html = renderToStaticMarkup(<TimezoneProvider><AccessSettings data={data} /></TimezoneProvider>);
    expect(html).toContain("pulsectl me --server https://pulse.example.com");
    expect(html).toContain("Open Device Approval");
  });

  it("caps visible scope chips and summarizes the overflow", () => {
    const scopes = ["monitors:read", "monitors:write", "incidents:read", "config:read", "config:write", "notifications:test", "tokens:manage", "status:read"];
    const wide: AccessSettingsData = {
      ...data,
      tokens: [{ ...data.tokens[1]!, scopes }],
    };
    const html = renderToStaticMarkup(<TimezoneProvider><AccessSettings data={wide} /></TimezoneProvider>);
    expect(html).toContain("monitors:read");
    expect(html).toContain("incidents:read");
    expect(html).not.toContain(">config:read<");
    expect(html).toContain(">+5</span>");
    expect(html).toContain("5 more scopes:");
  });

  it("renders an empty token state", () => {
    const html = renderToStaticMarkup(<TimezoneProvider><AccessSettings data={{ ...data, tokens: [] }} /></TimezoneProvider>);
    expect(html).toContain("No API tokens");
  });
});
