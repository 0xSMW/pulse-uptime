import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { IncidentEmpty } from "./incident-empty"

describe("IncidentEmpty", () => {
  it("does not prompt for setup when a monitor exists", () => {
    const html = renderToStaticMarkup(<IncidentEmpty hasMonitors />)

    expect(html).toContain("No incidents yet")
    expect(html).not.toContain("Add monitors")
  })

  it("links to setup when no monitor exists", () => {
    const html = renderToStaticMarkup(<IncidentEmpty />)

    expect(html).toContain("Add monitors")
    expect(html).toContain('href="/settings/monitors"')
  })
})
