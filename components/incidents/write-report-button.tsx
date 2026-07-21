"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import {
  type ApiEnvelope,
  apiRequest,
} from "@/components/settings/settings-api"
import { Button } from "@/components/ui/button"

import { messageForReportError } from "./report-errors"

/**
 * Promotes an auto-incident to a draft status report and opens its editor.
 * Promotion is idempotent server-side: if the incident already has a report,
 * the existing one comes back and we navigate to it just the same.
 */
export function WriteReportButton({ incidentId }: { incidentId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function promote() {
    setBusy(true)
    setError("")
    try {
      const result = await apiRequest<ApiEnvelope<{ id: string }>>(
        `/api/v1/incidents/${encodeURIComponent(incidentId)}/promote`,
        { method: "POST" },
        { mutation: true }
      )
      router.push(`/incidents/reports/${encodeURIComponent(result.data.id)}`)
    } catch (cause) {
      setError(messageForReportError(cause))
      setBusy(false)
    }
  }

  return (
    <span className="relative inline-flex items-center gap-2">
      <Button
        className="px-2.5"
        disabled={busy}
        onClick={() => void promote()}
        size="sm"
        variant="secondary"
      >
        {busy ? "Opening…" : "Write Report"}
      </Button>
      {/* Always-mounted error region so assistive tech hears late failures. */}
      <span className="text-[var(--down-text)] text-xs" role="alert">
        {error}
      </span>
    </span>
  )
}
