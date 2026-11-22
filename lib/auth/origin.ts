export function isAllowedOrigin(
  origin: string | null,
  appUrl: string
): boolean {
  if (!origin) {
    return false
  }

  try {
    const supplied = new URL(origin)
    return (
      supplied.origin === origin && supplied.origin === new URL(appUrl).origin
    )
  } catch {
    return false
  }
}

export function mutationOriginAllowed(request: Request) {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (!configured && process.env.NODE_ENV === "production") {
    return false
  }
  const appUrl = configured || new URL(request.url).origin
  return isAllowedOrigin(request.headers.get("origin"), appUrl)
}
