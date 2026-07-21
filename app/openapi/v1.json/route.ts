import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-static"

export async function GET() {
  const source = await readFile(
    join(process.cwd(), "openapi", "service.openapi.yaml"),
    "utf8"
  )
  const document: unknown = JSON.parse(source)
  return NextResponse.json(document, {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  })
}
