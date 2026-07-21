"use client"

import Link from "next/link"
import { useSyncExternalStore } from "react"

import { CodeBlock } from "@/components/ui/code-block"

export function CliCard({ origin: initialOrigin }: { origin: string }) {
  const browserOrigin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => ""
  )
  const server =
    initialOrigin || browserOrigin || "https://pulse.superposition.app"
  const code = `go install github.com/0xSMW/pulse-uptime/cli/cmd/pulsectl@latest
pulsectl me --server ${server}

# agents and CI
export PULSECTL_TOKEN=pulse_live_…
pulsectl monitor list --output json`

  return (
    <>
      <p className="mb-4 text-[13px] text-[var(--fg-muted)] leading-[18px]">
        Manage monitors from the terminal. Agents and CI use scoped tokens.
      </p>
      <CodeBlock className="mb-4 max-w-[640px]" code={code} language="shell" />
      <Link
        className="inline-flex h-8 items-center rounded-[6px] px-1.5 font-medium text-sm hover:bg-[var(--hover)]"
        href="/cli/authorize"
      >
        Open Device Approval <span aria-hidden="true">→</span>
      </Link>
    </>
  )
}
