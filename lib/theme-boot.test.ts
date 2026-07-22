import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import { THEME_BOOT_SCRIPT, THEME_BOOT_SCRIPT_SHA256 } from "./theme-boot"

describe("theme boot script", () => {
  it("keeps the CSP hash in lockstep with the script", () => {
    const digest = createHash("sha256")
      .update(THEME_BOOT_SCRIPT, "utf8")
      .digest("base64")
    expect(THEME_BOOT_SCRIPT_SHA256).toBe(`sha256-${digest}`)
  })
})
