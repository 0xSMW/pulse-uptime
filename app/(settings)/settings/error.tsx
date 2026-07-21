"use client"

import { useRouter } from "next/navigation"
import { startTransition } from "react"

import { Button } from "@/components/ui/button"

export default function SettingsError({
  reset,
}: {
  error: Error
  reset: () => void
}) {
  const router = useRouter()

  function retry() {
    startTransition(() => {
      router.refresh()
      reset()
    })
  }

  return (
    <div
      className="rounded-xl border border-[var(--border-strong)] p-6"
      role="alert"
    >
      <h2 className="font-semibold text-base">Settings unavailable</h2>
      <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
        Settings could not be loaded. Try again.
      </p>
      <Button className="mt-4" onClick={retry} variant="secondary">
        Retry
      </Button>
    </div>
  )
}
