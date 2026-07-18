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
        destination: "/settings/general",
        permanent: false,
      },
      {
        source: "/settings/notifications",
        destination: "/settings/general",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
