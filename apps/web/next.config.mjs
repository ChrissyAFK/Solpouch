import { securityHeaders } from "./security.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Production builds use their own folder so a dev build can't swap chunks under the live server.
  distDir: process.env.SOLPOUCH_DIST_DIR || ".next",
  transpilePackages: ["@solpouch/shared"],
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // The worker file must always revalidate so updates reach installed apps.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Content-Type", value: "text/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};
export default nextConfig;
