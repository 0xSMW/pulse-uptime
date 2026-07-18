"use client";

import type { ReactNode } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/dashboard/theme-provider";

import styles from "./auth.module.css";

export function AuthShell({ children }: { children: ReactNode }) {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.wordmark}><span className={styles.brandDot} />Pulse</div>
        <Button variant="secondary" size="icon-sm" aria-label={`Use ${dark ? "light" : "dark"} theme`} onClick={() => setTheme(dark ? "light" : "dark")}>
          {dark ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
        </Button>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

