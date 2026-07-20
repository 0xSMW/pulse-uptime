export function isAllowedOrigin(
  origin: string | null,
  appUrl: string,
): boolean {
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

export function mutationOriginAllowed(request: Request) {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  const appUrl = configured || new URL(request.url).origin;
  return isAllowedOrigin(request.headers.get("origin"), appUrl);
}
