const GOOGLE_ANALYTICS_ORIGINS = [
  "https://www.google-analytics.com",
  "https://region1.google-analytics.com",
] as const

export function buildStatusPageContentSecurityPolicy(
  nonce: string,
  development = process.env.NODE_ENV === "development"
): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: ${GOOGLE_ANALYTICS_ORIGINS.join(" ")}`,
    "font-src 'self'",
    `connect-src 'self' ${GOOGLE_ANALYTICS_ORIGINS.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]
  return directives.join("; ")
}
