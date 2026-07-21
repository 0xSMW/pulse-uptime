import type { NextConfig } from "next";

// Central browser security policy. The CSP constrains only framing, base URI,
// plugins, and form submission (not script/style/connect) because the App
// Router streams inline bootstrap scripts and there is no nonce middleware to
// allow them; a strict script-src would break hydration. frame-ancestors
// 'none' and X-Frame-Options together give the clickjacking protection.
const CONTENT_SECURITY_POLICY = [
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  // Bake the immutable deployment id into the server bundle at build time so
  // every cron run records which release executed it. Vercel provides
  // VERCEL_DEPLOYMENT_ID during build; tests and local set PULSE_RELEASE_ID.
  env: {
    PULSE_RELEASE_ID:
      process.env.PULSE_RELEASE_ID
      || process.env.VERCEL_DEPLOYMENT_ID
      || "",
  },
  experimental: {
    authInterrupts: true,
    // Client router cache. Two freshness tiers: revisited routes re-render
    // from memory for up to `dynamic` (30s), while data delivered through
    // prefetch={true} links can be served up to `static` (180s) old.
    // Mutations purge the whole cache via router.refresh(); cron-driven data
    // is kept honest by AutoRefresh (focus + interval).
    staleTimes: { dynamic: 30, static: 180 },
  },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  async redirects() {
    return [
      {
        source: "/settings",
        destination: "/settings/account",
        permanent: false,
      },
      // General was renamed to Notifications (IA v4); the old retirement
      // redirect in the other direction was removed to avoid a loop.
      {
        source: "/settings/general",
        destination: "/settings/notifications",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
