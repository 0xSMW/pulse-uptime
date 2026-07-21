"use client"

import * as React from "react"

export type Theme = "system" | "dark" | "light"
export type ResolvedTheme = Exclude<Theme, "system">

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

export interface ThemeProviderProps {
  children: React.ReactNode
  attribute?: "data-theme"
  defaultTheme?: Theme
  disableTransitionOnChange?: boolean
  enableSystem?: boolean
  forcedTheme?: ResolvedTheme
  storageKey?: string
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(
  undefined
)

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark"
}

function subscribeToSystemTheme(onStoreChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: light)")
  media.addEventListener("change", onStoreChange)
  return () => media.removeEventListener("change", onStoreChange)
}

function ThemeProvider({
  children,
  attribute = "data-theme",
  defaultTheme = "dark",
  disableTransitionOnChange = true,
  enableSystem = true,
  forcedTheme,
  storageKey = "pulse-theme",
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(
    forcedTheme ?? defaultTheme
  )
  const systemTheme = React.useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemTheme,
    (): ResolvedTheme => "dark"
  )
  const resolvedTheme: ResolvedTheme =
    forcedTheme ?? (theme === "system" ? systemTheme : theme)

  React.useEffect(() => {
    if (forcedTheme) {
      return
    }

    const savedTheme = window.localStorage.getItem(storageKey)
    if (
      savedTheme === "dark" ||
      savedTheme === "light" ||
      savedTheme === "system"
    ) {
      const nextTheme =
        savedTheme === "system" && !enableSystem ? defaultTheme : savedTheme
      queueMicrotask(() => setThemeState(nextTheme))
    }
  }, [defaultTheme, enableSystem, forcedTheme, storageKey])

  React.useEffect(() => {
    const root = document.documentElement
    if (disableTransitionOnChange) {
      root.classList.add("theme-changing")
    }

    root.setAttribute(attribute, resolvedTheme)
    root.style.colorScheme = resolvedTheme

    if (disableTransitionOnChange) {
      void root.offsetHeight
      root.classList.remove("theme-changing")
    }
  }, [attribute, disableTransitionOnChange, resolvedTheme])

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      const supportedTheme =
        nextTheme === "system" && !enableSystem ? defaultTheme : nextTheme
      window.localStorage.setItem(storageKey, supportedTheme)
      setThemeState(supportedTheme)
    },
    [defaultTheme, enableSystem, storageKey]
  )

  const value = React.useMemo(
    () => ({ theme: forcedTheme ?? theme, resolvedTheme, setTheme }),
    [forcedTheme, resolvedTheme, setTheme, theme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

function useTheme() {
  const context = React.useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}

export { ThemeProvider, useTheme }
