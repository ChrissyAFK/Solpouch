import { securityHeaders } from "./security.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@solpouch/shared"],
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};
export default nextConfig;
