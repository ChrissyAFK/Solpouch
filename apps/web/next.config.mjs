import { securityHeaders } from "./security.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Production builds use their own folder so a dev build can't swap chunks under the live server.
  distDir: process.env.SOLPOUCH_DIST_DIR || ".next",
  transpilePackages: ["@solpouch/shared"],
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};
export default nextConfig;
