"use client"

import { useRef } from "react"

import { type Theme, useTheme } from "@/components/dashboard/theme-provider"
import { cn } from "@/lib/utils"

const options: { label: string; value: Theme }[] = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
]

const palettes = {
  light: {
    bg: "#ffffff",
    surface: "#f4f4f5",
    line: "#e4e4e7",
    text: "#a1a1aa",
    accent: "#3f9142",
  },
  dark: {
    bg: "#09090b",
    surface: "#18181b",
    line: "#27272a",
    text: "#52525b",
    accent: "#4ade80",
  },
} as const

function ThumbnailContent({
  palette,
}: {
  palette: (typeof palettes)[keyof typeof palettes]
}) {
  return (
    <>
      <rect fill={palette.bg} height="56" width="88" />
      <rect fill={palette.text} height="3" rx="1.5" width="20" x="6" y="6" />
      <circle
        cx="76"
        cy="7.5"
        fill={palette.surface}
        r="3.5"
        stroke={palette.line}
      />
      <rect fill={palette.surface} height="14" rx="3" width="76" x="6" y="16" />
      <circle cx="13" cy="23" fill={palette.accent} r="2.5" />
      <rect
        fill={palette.text}
        height="3"
        rx="1.5"
        width="26"
        x="20"
        y="21.5"
      />
      <rect fill={palette.surface} height="14" rx="3" width="76" x="6" y="34" />
      <circle cx="13" cy="41" fill={palette.accent} r="2.5" />
      <rect
        fill={palette.text}
        height="3"
        rx="1.5"
        width="18"
        x="20"
        y="39.5"
      />
    </>
  )
}

/** Mini dashboard mock. System renders the light and dark halves split diagonally. */
function ThemeThumbnail({ variant }: { variant: Theme }) {
  if (variant !== "system") {
    return (
      <svg
        aria-hidden
        className="block"
        focusable="false"
        height="56"
        viewBox="0 0 88 56"
        width="88"
      >
        <ThumbnailContent palette={palettes[variant]} />
      </svg>
    )
  }
  return (
    <svg
      aria-hidden
      className="block"
      focusable="false"
      height="56"
      viewBox="0 0 88 56"
      width="88"
    >
      <defs>
        <clipPath id="appearance-split-light">
          <polygon points="0,0 88,0 0,56" />
        </clipPath>
        <clipPath id="appearance-split-dark">
          <polygon points="88,0 88,56 0,56" />
        </clipPath>
      </defs>
      <g clipPath="url(#appearance-split-dark)">
        <ThumbnailContent palette={palettes.dark} />
      </g>
      <g clipPath="url(#appearance-split-light)">
        <ThumbnailContent palette={palettes.light} />
      </g>
    </svg>
  )
}

export function AppearancePicker() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])

  function onKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0
    if (!delta) {
      return
    }
    event.preventDefault()
    const next = (index + delta + options.length) % options.length
    setTheme(options[next]!.value)
    buttons.current[next]?.focus()
  }

  return (
    <div>
      <div
        aria-label="Theme"
        className="flex flex-wrap gap-3"
        role="radiogroup"
      >
        {options.map((option, index) => {
          const selected = theme === option.value
          return (
            <button
              aria-checked={selected}
              className="group flex flex-col items-start gap-1.5 rounded-[8px]"
              key={option.value}
              onClick={() => setTheme(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              ref={(element) => {
                buttons.current[index] = element
              }}
              role="radio"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              <span
                className={cn(
                  "overflow-hidden rounded-[6px] border transition-shadow duration-150",
                  selected
                    ? "border-[var(--focus)] shadow-[0_0_0_2px_var(--focus)]"
                    : "border-[var(--border-strong)] group-hover:border-[var(--border-hover)]"
                )}
              >
                <ThemeThumbnail variant={option.value} />
              </span>
              <span
                className={cn(
                  "px-0.5 text-[12px]",
                  selected
                    ? "font-medium text-[var(--fg)]"
                    : "text-[var(--fg-muted)]"
                )}
              >
                {option.label}
              </span>
            </button>
          )
        })}
      </div>
      <p aria-live="polite" className="mt-2 text-[var(--fg-faint)] text-xs">
        {theme === "system"
          ? `Following your device · ${resolvedTheme}`
          : `${theme[0]?.toUpperCase()}${theme.slice(1)} appearance selected`}
      </p>
    </div>
  )
}
