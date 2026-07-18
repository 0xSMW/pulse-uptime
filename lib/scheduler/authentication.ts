import { timingSafeEqual } from "node:crypto";

export function isAuthorizedCronRequest(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export const CRON_RESPONSE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "content-type": "application/json",
} as const;
