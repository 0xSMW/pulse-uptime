import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { UserMenu } from "./user-menu"

describe("UserMenu", () => {
  it("renders a compact account trigger instead of the email", () => {
    const html = renderToStaticMarkup(<UserMenu email="ops@example.com" />)
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-label="Account"')
    expect(html).toContain('title="Account"')
    expect(html).toContain("lucide-user")
    expect(html).not.toContain("ops@example.com")
  })

  it("shows name initials in the trigger frame when a name is set", () => {
    const html = renderToStaticMarkup(
      <UserMenu email="ops@example.com" name="Ada Lovelace" />
    )
    expect(html).toContain("AL")
    expect(html).not.toContain("lucide-user")
  })

  it("renders the uploaded avatar in the trigger frame when set", () => {
    const html = renderToStaticMarkup(
      <UserMenu
        avatarImageId="11111111-1111-4111-8111-111111111111"
        email="ops@example.com"
      />
    )
    expect(html).toContain(
      'src="/api/v1/images/11111111-1111-4111-8111-111111111111"'
    )
    expect(html).not.toContain("lucide-user")
  })
})
