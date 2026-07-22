import { getStatusPageDisplayConfig } from "@/lib/reporting/queries/status"

export async function GET() {
  const config = await getStatusPageDisplayConfig()
  return new Response(config.customCss ?? "", {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/css; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
