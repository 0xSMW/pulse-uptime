"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"

import {
  type ApiEnvelope,
  apiRequest,
  messageForError,
} from "@/components/settings/settings-api"
import { useDirtyGuard } from "@/components/settings/settings-dirty"
import { CardHeading } from "@/components/settings/settings-row"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

export type NotificationSettingsData = {
  defaultRecipients: string[]
  sender: string | null
}

type DeclarativeConfig = {
  version: 1
  settings: Record<string, unknown> & { defaultRecipients: string[] }
  monitors: Array<Record<string, unknown>>
}
type ConfigurationMeta = { requestId?: string; configHash?: string }
type ConfigurationPlan = {
  baseConfigHash: string
  targetConfigHash: string
  planHash: string
  destructiveApprovalRequired: boolean
}
type ConfigurationOperation = {
  id: string
  state: "written" | "accepted" | "rejected" | "failed"
  rejectionReason: string | null
}

const OPERATION_POLL_INTERVAL_MS = 2000
const OPERATION_POLL_DEADLINE_MS = 30_000

export function NotificationsSettings({
  data,
}: {
  data: NotificationSettingsData
}) {
  const router = useRouter()
  const [savedText, setSavedText] = useState(data.defaultRecipients.join("\n"))
  const [recipientsText, setRecipientsText] = useState(savedText)
  const [notificationBusy, setNotificationBusy] = useState<
    "save" | "test" | null
  >(null)
  const [notificationStatus, setNotificationStatus] = useState("")
  const pollTimer = useRef<number | null>(null)

  useDirtyGuard("notifications-recipients", recipientsText !== savedText)

  useEffect(
    () => () => {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current)
      }
    },
    []
  )

  const recipients = recipientsText
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
  const recipientError =
    recipients.length > 20
      ? "Use no more than 20 addresses"
      : recipients.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        ? "Enter valid email addresses"
        : ""

  function stopPolling() {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current)
    }
    pollTimer.current = null
  }

  function pollOperation(
    operationId: string,
    deadline: number,
    committedText: string
  ) {
    const tick = async () => {
      pollTimer.current = null
      try {
        const envelope = await apiRequest<ApiEnvelope<ConfigurationOperation>>(
          `/api/v1/config/operations/${encodeURIComponent(operationId)}`
        )
        const { state, rejectionReason } = envelope.data
        if (state === "accepted") {
          setNotificationStatus("Recipients saved")
          setNotificationBusy(null)
          setSavedText(committedText)
          router.refresh()
          return
        }
        if (state === "rejected" || state === "failed") {
          setNotificationStatus(
            rejectionReason ||
              "Configuration update failed. Reload and try again."
          )
          setNotificationBusy(null)
          return
        }
      } catch {
        // Transient poll failure; keep polling until the deadline.
      }
      if (Date.now() >= deadline) {
        setNotificationStatus("Still applying. Reload to confirm.")
        setNotificationBusy(null)
        return
      }
      pollTimer.current = window.setTimeout(() => {
        void tick()
      }, OPERATION_POLL_INTERVAL_MS)
    }
    pollTimer.current = window.setTimeout(() => {
      void tick()
    }, OPERATION_POLL_INTERVAL_MS)
  }

  async function saveRecipients() {
    if (recipientError) {
      setNotificationStatus(recipientError)
      return
    }
    stopPolling()
    setNotificationBusy("save")
    setNotificationStatus("")
    const committedText = recipientsText
    try {
      const current = await apiRequest<
        ApiEnvelope<DeclarativeConfig> & { meta: ConfigurationMeta }
      >("/api/v1/config")
      const baseConfigHash = current.meta.configHash
      if (!baseConfigHash) {
        throw new Error(
          "Configuration hash is unavailable. Reload before saving."
        )
      }
      const targetConfig: DeclarativeConfig = {
        ...current.data,
        settings: { ...current.data.settings, defaultRecipients: recipients },
      }
      const planned = await apiRequest<ApiEnvelope<ConfigurationPlan>>(
        "/api/v1/config/plan",
        {
          method: "POST",
          body: JSON.stringify({ baseConfigHash, targetConfig }),
        },
        true
      )
      const applied = await apiRequest<ApiEnvelope<ConfigurationOperation>>(
        "/api/v1/config/apply",
        {
          method: "POST",
          headers: { "If-Match": `"${baseConfigHash}"` },
          body: JSON.stringify({
            baseConfigHash,
            targetConfigHash: planned.data.targetConfigHash,
            planHash: planned.data.planHash,
            targetConfig,
            allowDelete: false,
          }),
        },
        true
      )
      setNotificationStatus("Updating configuration…")
      pollOperation(
        applied.data.id,
        Date.now() + OPERATION_POLL_DEADLINE_MS,
        committedText
      )
    } catch (error) {
      setNotificationStatus(messageForError(error))
      setNotificationBusy(null)
    }
  }

  async function sendTestNotification() {
    if (recipientError) {
      setNotificationStatus(recipientError)
      return
    }
    setNotificationBusy("test")
    setNotificationStatus("")
    try {
      await apiRequest(
        "/api/v1/notifications/test",
        {
          method: "POST",
          body: JSON.stringify(
            recipients[0] ? { recipient: recipients[0] } : {}
          ),
        },
        true
      )
      setNotificationStatus(
        recipients[0]
          ? `Test sent to ${recipients[0]}`
          : "Test notification accepted"
      )
    } catch (error) {
      setNotificationStatus(messageForError(error))
    } finally {
      setNotificationBusy((current) => (current === "test" ? null : current))
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeading title="Email" />
        <CardContent className="pt-0">
          <p className="mb-4 max-w-[640px] text-[13px] text-[var(--fg-muted)] leading-[18px]">
            Defaults apply when a monitor has no recipients. Use one address per
            line, up to 20.
          </p>
          <div className="max-w-[640px] space-y-4">
            <label className="block">
              <span className="mb-2 block font-medium text-[13px]">
                Default Recipients
              </span>
              <textarea
                aria-invalid={Boolean(recipientError)}
                className="w-full resize-y rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 font-data text-[13px] leading-5"
                onChange={(e) => setRecipientsText(e.target.value)}
                placeholder="ops@example.com"
                rows={Math.max(3, Math.min(recipients.length || 3, 6))}
                value={recipientsText}
              />
              {recipientError ? (
                <span className="mt-1 block text-[var(--down-text)] text-xs">
                  {recipientError}
                </span>
              ) : null}
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3 border-[var(--border)] border-t pt-4">
              <span className="font-data text-[13px] text-[var(--fg-muted)]">
                {data.sender
                  ? `${data.sender} via Resend`
                  : "Email sender is not configured"}
              </span>
              <div className="flex gap-2">
                <Button
                  disabled={Boolean(notificationBusy)}
                  onClick={sendTestNotification}
                  variant="secondary"
                >
                  {notificationBusy === "test" ? "Sending…" : "Send Test Email"}
                </Button>
                <Button
                  disabled={
                    Boolean(notificationBusy) || Boolean(recipientError)
                  }
                  onClick={saveRecipients}
                >
                  {notificationBusy === "save" ? "Saving…" : "Save Recipients"}
                </Button>
              </div>
            </div>
            {notificationStatus ? (
              <p
                aria-live="polite"
                className={`text-[13px] ${notificationStatus.includes("changed elsewhere") || notificationStatus.includes("unavailable") || notificationStatus.includes("failed") ? "text-[var(--down-text)]" : "text-[var(--fg-muted)]"}`}
              >
                {notificationStatus}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
