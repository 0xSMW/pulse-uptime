// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { isReportEditorDirty, setReportEditorDirty } from "./report-editor-dirty";

afterEach(() => {
  setReportEditorDirty(false);
});

describe("report editor dirty flag", () => {
  it("defaults to clean", () => {
    expect(isReportEditorDirty()).toBe(false);
  });

  it("tracks the flag set by the editor", () => {
    setReportEditorDirty(true);
    expect(isReportEditorDirty()).toBe(true);
    setReportEditorDirty(false);
    expect(isReportEditorDirty()).toBe(false);
  });
});
