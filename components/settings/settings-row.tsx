import type { ReactNode } from "react"

import { CardHeader, CardTitle } from "@/components/ui/card"

export function CardHeading({
  title,
  action,
}: {
  title: string
  action?: ReactNode
}) {
  return (
    <CardHeader className="flex-row items-center justify-between gap-4 p-6 pb-4">
      <CardTitle>{title}</CardTitle>
      {action}
    </CardHeader>
  )
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-[60px] flex-wrap items-center justify-between gap-x-6 gap-y-2 border-[var(--border)] border-b px-6 py-4 last:border-0">
      <div className="min-w-0">
        <p className="font-medium text-[13px]">{label}</p>
        {description ? (
          <p className="mt-0.5 text-[13px] text-[var(--fg-muted)]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}
