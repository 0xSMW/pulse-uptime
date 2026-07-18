import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UserMenu } from "./user-menu";

describe("UserMenu", () => {
  it("renders a compact account trigger instead of the email", () => {
    const html = renderToStaticMarkup(<UserMenu email="ops@example.com" />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain('title="Account"');
    expect(html).toContain("lucide-circle-user");
    expect(html).not.toContain("ops@example.com");
  });
});
