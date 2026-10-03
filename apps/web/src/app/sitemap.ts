import type { MetadataRoute } from "next";
import { allowIndexing, siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  // Account-specific routes and orders never belong in the public sitemap.
  return allowIndexing && siteUrl ? [{ url: siteUrl.href }] : [];
}
