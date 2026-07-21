"use client"

import { Moon, Sun } from "lucide-react"
import type { ReactNode } from "react"
import { useTheme } from "@/components/dashboard/theme-provider"
import { Button } from "@/components/ui/button"

import styles from "./auth.module.css"

export function AuthShell({ children }: { children: ReactNode }) {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.wordmark}>
          <span className={styles.brandDot} />
          Pulse
        </div>
        <Button
          aria-label={`Use ${dark ? "light" : "dark"} theme`}
          onClick={() => setTheme(dark ? "light" : "dark")}
          size="icon-sm"
          variant="secondary"
        >
          {dark ? (
            <Sun aria-hidden="true" size={15} />
          ) : (
            <Moon aria-hidden="true" size={15} />
          )}
        </Button>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  )
}
