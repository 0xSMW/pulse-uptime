import { beforeEach, describe, expect, it, vi } from "vitest"

const { getStatusPageDisplayConfig } = vi.hoisted(() => ({
  getStatusPageDisplayConfig: vi.fn(),
}))

vi.mock("@/lib/reporting/queries/status", () => ({
  getStatusPageDisplayConfig,
}))

import { GET } from "./route"

describe("GET /status/custom.css", () => {
  beforeEach(() => {
    getStatusPageDisplayConfig.mockReset()
  })

  it("serves configured CSS as a non-HTML resource", async () => {
    const css = "</style><script>alert(1)</script><style>"
    getStatusPageDisplayConfig.mockResolvedValue({ customCss: css })

    const response = await GET()

    expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.text()).toBe(css)
  })

  it("serves an empty stylesheet when customization is disabled", async () => {
    getStatusPageDisplayConfig.mockResolvedValue({ customCss: null })

    expect(await (await GET()).text()).toBe("")
  })
})
