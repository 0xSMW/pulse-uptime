/**
 * Tiny module-level dirty flag for the status-report editor. The editor lives
 * outside the settings shell (and its unsaved-changes guard), so the incidents
 * surface threads this flag between the editor, the back link, and the tabs
 * without a context provider. Client-only module: no React state needed
 * because readers only consult the flag at navigation time.
 *
 * This module exports only the flag, not a confirm helper: ReportEditor's
 * `useNavigationGuard` (a document-wide click/popstate/beforeunload guard
 * backed by an in-app modal) already confirms before every link in the
 * document, including ReportBackLink and IncidentsTabs, so a second confirm
 * from this module would double-prompt.
 */

let dirtyFlag = false;

export function setReportEditorDirty(next: boolean): void {
  dirtyFlag = next;
}

export function isReportEditorDirty(): boolean {
  return dirtyFlag;
}

export const UNSAVED_CHANGES_MESSAGE = "You have unsaved changes that will be lost. Leave this report?";
