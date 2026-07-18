/**
 * Tiny module-level dirty flag for the status-report editor. The editor lives
 * outside the settings shell (and its unsaved-changes guard), so the incidents
 * surface threads this flag between the editor, the back link, and the tabs
 * without a context provider. Client-only module — no React state needed
 * because readers only consult the flag at navigation time.
 */

let dirtyFlag = false;

export function setReportEditorDirty(next: boolean): void {
  dirtyFlag = next;
}

export function isReportEditorDirty(): boolean {
  return dirtyFlag;
}

export const UNSAVED_CHANGES_MESSAGE = "You have unsaved changes that will be lost. Leave this report?";

/**
 * Returns true when navigation may proceed. Prompts only while the editor is
 * dirty; a confirmed leave clears the flag so later links do not re-prompt.
 */
export function confirmDiscardUnsaved(): boolean {
  if (!dirtyFlag) return true;
  const leave = window.confirm(UNSAVED_CHANGES_MESSAGE);
  if (leave) dirtyFlag = false;
  return leave;
}
