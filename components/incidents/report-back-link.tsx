"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { confirmDiscardUnsaved } from "./report-editor-dirty";

/** "← Reports" back link that honors the editor's unsaved-changes guard. */
export function ReportBackLink() {
  return (
    <Link
      href="/incidents/reports"
      onClick={(event) => {
        if (!confirmDiscardUnsaved()) event.preventDefault();
      }}
      className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      Reports
    </Link>
  );
}
