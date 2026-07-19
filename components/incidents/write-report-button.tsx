"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { apiRequest, type ApiEnvelope } from "@/components/settings/settings-api";

import { messageForReportError } from "./report-errors";

/**
 * Promotes an auto-incident to a draft status report and opens its editor.
 * Promotion is idempotent server-side: if the incident already has a report,
 * the existing one comes back and we navigate to it just the same.
 */
export function WriteReportButton({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function promote() {
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<ApiEnvelope<{ id: string }>>(
        `/api/v1/incidents/${encodeURIComponent(incidentId)}/promote`,
        { method: "POST" },
        true,
      );
      router.push(`/incidents/reports/${encodeURIComponent(result.data.id)}`);
    } catch (cause) {
      setError(messageForReportError(cause));
      setBusy(false);
    }
  }

  return (
    <span className="relative inline-flex items-center gap-2">
      <Button variant="secondary" size="sm" className="px-2.5" onClick={() => void promote()} disabled={busy}>
        {busy ? "Opening…" : "Write Report"}
      </Button>
      {/* Always-mounted error region so assistive tech hears late failures. */}
      <span role="alert" className="text-xs text-[var(--down-text)]">{error}</span>
    </span>
  );
}
