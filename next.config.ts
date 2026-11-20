import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The running bundle's version, baked in at build time from the
  // Vercel commit SHA, so the app can tell a newer deploy exists
  // (see /api/version and client/appUpdate.tsx). "local" outside Vercel.
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
  },
  // The intro videos are imported as static assets by the client.
  experimental: {
    optimizePackageImports: ["recharts"],
  },
};

export default nextConfig;
