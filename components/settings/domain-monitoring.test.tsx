// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  DomainMonitoringCard,
  type DomainMonitoringData,
  formatDomainMonitoringSuccess,
} from "./domain-monitoring"

const connectedData: DomainMonitoringData = {
  state: "CONNECTED",
  coveredDomainCount: 2,
  lastSuccessAt: "2026-07-26T03:04:00.000Z",
  webhookStatus: "ACTIVE",
  expiryAlertsEnabled: true,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("DomainMonitoringCard", () => {
  it("renders Porkbun registration separately from direct TLS certificates", () => {
    const html = renderToStaticMarkup(
      <DomainMonitoringCard data={connectedData} />
    )

    expect(html).toContain("Domain monitoring")
    expect(html).toContain("Connected")
    expect(html).toContain("2 domains")
    expect(html).toContain("Jul 26 03:04 UTC")
    expect(html).toContain("Registration uses Porkbun")
    expect(html).toContain("Certificate checks use direct TLS probes")
    expect(html).toContain("Check connection")
    expect(html).toContain("Send test")
    expect(html).toContain("Disable")
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
  })

  it("disables expiry alerts until Porkbun is connected", () => {
    const html = renderToStaticMarkup(
      <DomainMonitoringCard
        data={{
          ...connectedData,
          state: "NOT_CONFIGURED",
          coveredDomainCount: 0,
          lastSuccessAt: null,
          webhookStatus: "NOT_CONFIGURED",
          expiryAlertsEnabled: false,
        }}
      />
    )

    expect(html).toContain("Not configured")
    expect(html).toContain("0 domains")
    expect(html).toContain("Never")
    expect(html).toContain("Connect Porkbun to enable expiry alerts")
    expect(html).toContain('disabled=""')
  })

  it("requires reconnection before enabling alerts but still allows disabling", () => {
    const disabledHtml = renderToStaticMarkup(
      <DomainMonitoringCard
        data={{
          ...connectedData,
          state: "NEEDS_ATTENTION",
          expiryAlertsEnabled: false,
        }}
      />
    )
    const enabledHtml = renderToStaticMarkup(
      <DomainMonitoringCard
        data={{
          ...connectedData,
          state: "NEEDS_ATTENTION",
          expiryAlertsEnabled: true,
        }}
      />
    )

    expect(disabledHtml).toContain("Reconnect Porkbun to resume updates")
    expect(disabledHtml).toContain('disabled=""')
    expect(enabledHtml).not.toContain('disabled=""')
  })

  it("offers webhook recovery actions when delivery needs attention", () => {
    const html = renderToStaticMarkup(
      <DomainMonitoringCard
        data={{ ...connectedData, webhookStatus: "FAILING" }}
      />
    )

    expect(html).toContain("Reconnect webhook")
    expect(html).toContain("Send test")
    expect(html).not.toContain(">Disable</button>")
  })

  it("persists expiry alert changes through the settings endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { ...connectedData, expiryAlertsEnabled: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    render(<DomainMonitoringCard data={connectedData} />)

    const toggle = screen.getByRole("switch", {
      name: "Toggle expiry alerts",
    })
    fireEvent.click(toggle)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/domain-monitoring/settings",
      expect.objectContaining({ method: "PATCH" })
    )
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      expiryAlertsEnabled: false,
    })
  })

  it("checks the connection and enables a webhook with the supplied contracts", async () => {
    const user = connectedData
    const connectedWithoutWebhook: DomainMonitoringData = {
      ...user,
      webhookStatus: "NOT_CONFIGURED",
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: connectedWithoutWebhook }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { ...connectedWithoutWebhook, webhookStatus: "ACTIVE" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    vi.stubGlobal("fetch", fetchMock)
    render(
      <DomainMonitoringCard
        data={{ ...connectedData, state: "NOT_CONFIGURED" }}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Check connection" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/domain-monitoring/check",
      expect.objectContaining({ method: "POST" })
    )
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({})

    fireEvent.click(screen.getByRole("button", { name: "Enable webhook" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/domain-monitoring/webhook",
      expect.objectContaining({ method: "POST" })
    )
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      action: "enable",
    })
  })
})

describe("formatDomainMonitoringSuccess", () => {
  it("uses a stable UTC timestamp and handles unavailable data", () => {
    expect(formatDomainMonitoringSuccess("2026-07-26T03:04:00.000Z")).toBe(
      "Jul 26 03:04 UTC"
    )
    expect(formatDomainMonitoringSuccess(null)).toBe("Never")
    expect(formatDomainMonitoringSuccess("invalid")).toBe("Unavailable")
  })
})
