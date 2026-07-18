import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    authInterrupts: true,
  },
  poweredByHeader: false,
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
