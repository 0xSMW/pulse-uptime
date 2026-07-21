"use client"

import { MoreHorizontal } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { apiRequest } from "@/components/settings/settings-api"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { messageForReportError } from "./report-errors"

export function ReportRowActions({
  reportId,
  title,
}: {
  reportId: string
  title: string
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function deleteReport() {
    setBusy(true)
    setError("")
    try {
      await apiRequest(
        `/api/v1/status-reports/${encodeURIComponent(reportId)}`,
        { method: "DELETE" },
        { mutation: true }
      )
      setConfirming(false)
      router.refresh()
    } catch (cause) {
      setError(messageForReportError(cause))
    } finally {
      setBusy(false)
    }
  }

  // relative z-10 keeps the menu trigger and confirm buttons above the
  // row's stretched-link overlay so they receive their own clicks.
  return (
    <span className="relative z-10 flex items-center gap-2">
      {confirming ? (
        <>
          <span className="text-[var(--fg-muted)] text-xs">Delete report?</span>
          <Button
            disabled={busy}
            onClick={() => void deleteReport()}
            size="sm"
            variant="error"
          >
            {busy ? "Deleting…" : "Confirm"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              setError("")
            }}
            size="sm"
            variant="secondary"
          >
            Cancel
          </Button>
        </>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Actions for ${title}`}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-[var(--fg-muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <MoreHorizontal aria-hidden className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLinkItem
              href={`/incidents/reports/${encodeURIComponent(reportId)}`}
            >
              Edit
            </DropdownMenuLinkItem>
            <DropdownMenuItem
              className="text-[var(--down-text)] data-[highlighted]:text-[var(--down-text)]"
              onClick={() => setConfirming(true)}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* Always-mounted error region so assistive tech hears late failures. */}
      <span className="text-[var(--down-text)] text-xs" role="alert">
        {error}
      </span>
    </span>
  )
}
