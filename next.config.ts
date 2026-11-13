import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The intro videos are imported as static assets by the client.
  experimental: {
    optimizePackageImports: ["recharts"],
  },
};

export default nextConfig;
