"use client";

import { useTheme, type Theme } from "@/components/dashboard/theme-provider";
import { cn } from "@/lib/utils";

const themes: { label: string; value: Theme }[] = [
  { label: "System", value: "system" },
  { label: "Dark", value: "dark" },
  { label: "Light", value: "light" },
];

export function AppearanceControl() {
  const { theme, resolvedTheme, setTheme } = useTheme();

  return (
    <div>
      <div
        className="inline-flex rounded-[6px] border border-[var(--border-strong)] bg-[var(--code-bg)] p-0.5"
        role="group"
        aria-label="Appearance"
      >
        {themes.map((option) => {
          const selected = theme === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => setTheme(option.value)}
              className={cn(
                "h-8 rounded-[4px] px-3 text-[13px] font-medium text-[var(--fg-muted)] transition-[background-color,color,box-shadow] duration-150",
                selected &&
                  "bg-[var(--bg)] text-[var(--fg)] shadow-[0_1px_2px_rgb(0_0_0/16%)]",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-[var(--fg-faint)]" aria-live="polite">
        {theme === "system"
          ? `Following your device · ${resolvedTheme}`
          : `${theme[0]?.toUpperCase()}${theme.slice(1)} appearance selected`}
      </p>
    </div>
  );
}
