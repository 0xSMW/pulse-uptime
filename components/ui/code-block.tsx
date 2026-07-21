"use client"

import { Check, Copy } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  code: string
  language?: string
  copyLabel?: string
}

function CodeBlock({
  className,
  code,
  copyLabel = "Copy Code",
  language,
  ...props
}: CodeBlockProps) {
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(
    () => () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current)
      }
    },
    []
  )

  async function copyCode() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    if (resetTimer.current) {
      clearTimeout(resetTimer.current)
    }
    resetTimer.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[6px] border border-[var(--code-border)] bg-[var(--code-bg)]",
        className
      )}
      {...props}
    >
      <pre className="hide-scrollbar overflow-x-auto p-4 pr-12 font-mono text-[var(--fg)] text-xs leading-5 [font-variant-numeric:tabular-nums]">
        <code data-language={language}>{code}</code>
      </pre>
      <Button
        aria-label={copied ? "Code copied" : copyLabel}
        className="absolute top-2 right-2 bg-[var(--code-bg)]"
        onClick={() => void copyCode()}
        size="icon-sm"
        title={copied ? "Copied" : copyLabel}
        variant="tertiary"
      >
        {copied ? (
          <Check aria-hidden="true" size={16} />
        ) : (
          <Copy aria-hidden="true" size={16} />
        )}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Code copied" : ""}
      </span>
    </div>
  )
}

export { CodeBlock }
