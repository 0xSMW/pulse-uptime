import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
  IncidentFilters,
  IncidentListPagination,
  incidentListHref,
} from "./incident-filters"

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

describe("IncidentListPagination", () => {
  it("renders nothing when everything fits on one page", () => {
    expect(
      renderToStaticMarkup(
        <IncidentListPagination
          cursor={null}
          filter="all"
          monitorId={null}
          nextCursor={null}
        />
      )
    ).toBe("")
  })

  it("links older incidents with the status and monitor filters kept", () => {
    const html = renderToStaticMarkup(
      <IncidentListPagination
        cursor={null}
        filter="resolved"
        monitorId="public-api"
        nextCursor="abc"
      />
    )
    expect(html).toContain(
      'href="/incidents?filter=resolved&amp;monitor=public-api&amp;cursor=abc"'
    )
    expect(html).toContain("Older incidents")
    expect(html).not.toContain("Latest incidents")
  })

  it("returns to the first page, labeled Latest, with filters kept from a later page", () => {
    const html = renderToStaticMarkup(
      <IncidentListPagination
        cursor="abc"
        filter="resolved"
        monitorId="public-api"
        nextCursor={null}
      />
    )
    expect(html).toMatch(
      /href="\/incidents\?filter=resolved&amp;monitor=public-api"[^>]*>← Latest incidents/
    )
    expect(html).not.toContain("cursor=")
    expect(html).not.toContain("Newer incidents")
    expect(html).not.toContain("Older incidents")
  })

  it("keeps both links on a middle page, with the back link dropping the cursor", () => {
    const html = renderToStaticMarkup(
      <IncidentListPagination
        cursor="abc"
        filter="ongoing"
        monitorId={null}
        nextCursor="def"
      />
    )
    expect(html).toMatch(
      /href="\/incidents\?filter=ongoing"[^>]*>← Latest incidents/
    )
    expect(html).toMatch(
      /href="\/incidents\?filter=ongoing&amp;cursor=def"[^>]*>Older incidents/
    )
  })
})
