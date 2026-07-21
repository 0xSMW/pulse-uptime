import type { ReactNode } from "react"

import { AuthShell } from "./shell"

export default function Layout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>
}
