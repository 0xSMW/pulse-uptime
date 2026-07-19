"use client";

import { MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiRequest } from "@/components/settings/settings-api";

import { messageForReportError } from "./report-errors";

export function ReportRowActions({ reportId, title }: { reportId: string; title: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function destroy() {
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/api/v1/status-reports/${encodeURIComponent(reportId)}`, { method: "DELETE" }, true);
      setConfirming(false);
      router.refresh();
    } catch (cause) {
      setError(messageForReportError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      {confirming ? (
        <>
          <span className="text-xs text-[var(--fg-muted)]">Delete report?</span>
          <Button variant="error" size="sm" onClick={() => void destroy()} disabled={busy}>
            {busy ? "Deleting…" : "Confirm"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { setConfirming(false); setError(""); }} disabled={busy}>
            Cancel
          </Button>
        </>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Actions for ${title}`}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-[var(--fg-muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLinkItem href={`/incidents/reports/${encodeURIComponent(reportId)}`}>Edit</DropdownMenuLinkItem>
            <DropdownMenuItem className="text-[var(--down-text)] data-[highlighted]:text-[var(--down-text)]" onClick={() => setConfirming(true)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* Always-mounted error region so assistive tech hears late failures. */}
      <span role="alert" className="text-xs text-[var(--down-text)]">{error}</span>
    </span>
  );
}
