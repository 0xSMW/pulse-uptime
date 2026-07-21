import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[520px] items-center px-6">
      <Card className="w-full text-center">
        <p className="font-data text-[var(--fg-muted)] text-xs uppercase tracking-[0.14em]">
          404
        </p>
        <h1 className="mt-3 font-semibold text-xl">Page not found</h1>
        <p className="mt-2 text-[var(--fg-muted)]">Return to your monitors</p>
        <Link className={buttonVariants({ className: "mt-6 w-full" })} href="/">
          Open Overview
        </Link>
      </Card>
    </main>
  )
}
