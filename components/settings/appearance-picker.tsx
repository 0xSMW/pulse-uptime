"use client";

import { useRef } from "react";

import { useTheme, type Theme } from "@/components/dashboard/theme-provider";
import { cn } from "@/lib/utils";

const options: { label: string; value: Theme }[] = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
];

const palettes = {
  light: { bg: "#ffffff", surface: "#f4f4f5", line: "#e4e4e7", text: "#a1a1aa", accent: "#3f9142" },
  dark: { bg: "#09090b", surface: "#18181b", line: "#27272a", text: "#52525b", accent: "#4ade80" },
} as const;

function ThumbnailContent({ palette }: { palette: (typeof palettes)[keyof typeof palettes] }) {
  return (
    <>
      <rect width="88" height="56" fill={palette.bg} />
      <rect x="6" y="6" width="20" height="3" rx="1.5" fill={palette.text} />
      <circle cx="76" cy="7.5" r="3.5" fill={palette.surface} stroke={palette.line} />
      <rect x="6" y="16" width="76" height="14" rx="3" fill={palette.surface} />
      <circle cx="13" cy="23" r="2.5" fill={palette.accent} />
      <rect x="20" y="21.5" width="26" height="3" rx="1.5" fill={palette.text} />
      <rect x="6" y="34" width="76" height="14" rx="3" fill={palette.surface} />
      <circle cx="13" cy="41" r="2.5" fill={palette.accent} />
      <rect x="20" y="39.5" width="18" height="3" rx="1.5" fill={palette.text} />
    </>
  );
}

/** Mini dashboard mock; System renders the light and dark halves split diagonally. */
function ThemeThumbnail({ variant }: { variant: Theme }) {
  if (variant !== "system") {
    return (
      <svg viewBox="0 0 88 56" width="88" height="56" aria-hidden focusable="false" className="block">
        <ThumbnailContent palette={palettes[variant]} />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 88 56" width="88" height="56" aria-hidden focusable="false" className="block">
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
  );
}

export function AppearancePicker() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1
      : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    setTheme(options[next]!.value);
    buttons.current[next]?.focus();
  }

  return (
    <div>
      <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-3">
        {options.map((option, index) => {
          const selected = theme === option.value;
          return (
            <button
              key={option.value}
              ref={(element) => { buttons.current[index] = element; }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTheme(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className="group flex flex-col items-start gap-1.5 rounded-[8px]"
            >
              <span
                className={cn(
                  "overflow-hidden rounded-[6px] border transition-shadow duration-150",
                  selected
                    ? "border-[var(--focus)] shadow-[0_0_0_2px_var(--focus)]"
                    : "border-[var(--border-strong)] group-hover:border-[var(--border-hover)]",
                )}
              >
                <ThemeThumbnail variant={option.value} />
              </span>
              <span
                className={cn(
                  "px-0.5 text-[12px]",
                  selected ? "font-medium text-[var(--fg)]" : "text-[var(--fg-muted)]",
                )}
              >
                {option.label}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-[var(--fg-faint)]" aria-live="polite">
        {theme === "system"
          ? `Following your device · ${resolvedTheme}`
          : `${theme[0]?.toUpperCase()}${theme.slice(1)} appearance selected`}
      </p>
    </div>
  );
}
