import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The running bundle's version, baked in at build time from the
  // deploy's commit SHA, so the app can tell a newer deploy exists
  // (see /api/version and client/appUpdate.tsx). Vercel provides
  // VERCEL_GIT_COMMIT_SHA; Netlify provides COMMIT_REF. "local" when
  // neither is set (local dev).
  env: {
    NEXT_PUBLIC_APP_VERSION:
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
      process.env.COMMIT_REF?.slice(0, 7) ??
      "local",
  },
  // The intro videos are imported as static assets by the client.
  experimental: {
    optimizePackageImports: ["recharts"],
  },
};

export default nextConfig;
