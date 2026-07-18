// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmDiscardUnsaved,
  isReportEditorDirty,
  setReportEditorDirty,
  UNSAVED_CHANGES_MESSAGE,
} from "./report-editor-dirty";

afterEach(() => {
  setReportEditorDirty(false);
  vi.unstubAllGlobals();
});

describe("confirmDiscardUnsaved", () => {
  it("allows navigation without prompting while clean", () => {
    const confirmMock = vi.fn();
    vi.stubGlobal("confirm", confirmMock);
    expect(confirmDiscardUnsaved()).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("blocks navigation when dirty and the user declines", () => {
    setReportEditorDirty(true);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    expect(confirmDiscardUnsaved()).toBe(false);
    expect(isReportEditorDirty()).toBe(true);
  });

  it("clears the flag when the user confirms leaving", () => {
    setReportEditorDirty(true);
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmMock);
    expect(confirmDiscardUnsaved()).toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(UNSAVED_CHANGES_MESSAGE);
    expect(isReportEditorDirty()).toBe(false);
  });
});
