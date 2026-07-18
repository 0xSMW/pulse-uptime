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
