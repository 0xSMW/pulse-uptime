"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

/**
 * "← Reports" back link. The editor's unsaved-changes guard (mounted by
 * ReportEditor via useNavigationGuard) is a document-wide click listener,
 * so it already confirms before this link navigates away; this component
 * no longer needs its own check.
 */
export function ReportBackLink() {
  return (
    <Link
      href="/incidents/reports"
      className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      Reports
    </Link>
  );
}
