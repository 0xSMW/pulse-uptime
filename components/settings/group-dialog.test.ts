import { describe, expect, it } from "vitest";

import { validateGroupName } from "./group-dialog";

describe("Group dialog helpers", () => {
  it("requires a concise group name", () => {
    expect(validateGroupName("   ")).toBe("Enter a group name");
    expect(validateGroupName("a".repeat(51))).toBe("Use 50 characters or fewer");
    expect(validateGroupName("Core services")).toBe("");
  });
});
