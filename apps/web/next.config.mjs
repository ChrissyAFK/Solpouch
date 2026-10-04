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
      // Static offline fallback: it skips the per-request policy, so it carries its own.
      {
        source: "/offline.html",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};
export default nextConfig;
