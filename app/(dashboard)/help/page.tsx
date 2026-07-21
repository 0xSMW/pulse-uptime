import type { Metadata } from "next"

import { HelpCenter } from "@/components/help/help-center"

export const metadata: Metadata = {
  title: "Help",
  description: "How Pulse monitors, alerts, and reports, with live examples",
}

export default function HelpPage() {
  return <HelpCenter />
}
