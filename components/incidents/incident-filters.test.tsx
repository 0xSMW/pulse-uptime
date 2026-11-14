import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { IncidentFilters, incidentListHref } from "./incident-filters"

describe("incidentListHref", () => {
  it("links the unfiltered list without a query", () => {
    expect(incidentListHref("all")).toBe("/incidents")
  })

  it("keeps the status filter", () => {
    expect(incidentListHref("ongoing")).toBe("/incidents?filter=ongoing")
  })

  it("keeps the monitor filter on every status", () => {
    expect(incidentListHref("all", "public api")).toBe(
      "/incidents?monitor=public+api"
    )
    expect(incidentListHref("ongoing", "public-api")).toBe(
      "/incidents?filter=ongoing&monitor=public-api"
    )
    expect(incidentListHref("resolved", "public-api")).toBe(
      "/incidents?filter=resolved&monitor=public-api"
    )
  })
})

describe("IncidentFilters", () => {
  it("preserves the monitor filter in all three status links", () => {
    const html = renderToStaticMarkup(
      <IncidentFilters active="resolved" monitorId="public-api" />
    )
    expect(html).toContain('href="/incidents?monitor=public-api"')
    expect(html).toContain(
      'href="/incidents?filter=ongoing&amp;monitor=public-api"'
    )
    expect(html).toContain(
      'href="/incidents?filter=resolved&amp;monitor=public-api"'
    )
    expect(html).toMatch(/aria-current="page"[^>]*>Resolved</)
  })

  it("links plain status filters without a monitor", () => {
    const html = renderToStaticMarkup(<IncidentFilters active="all" />)
    expect(html).toContain('href="/incidents"')
    expect(html).toContain('href="/incidents?filter=ongoing"')
    expect(html).not.toContain("monitor=")
  })
})
