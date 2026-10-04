import type { MetadataRoute } from "next";
import { allowIndexing, siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  // Account-specific routes and orders never belong in the public sitemap.
  if (!allowIndexing || !siteUrl) return [];
  return [
    siteUrl.href,
    new URL("/about", siteUrl).href,
    new URL("/contact", siteUrl).href,
    new URL("/privacy", siteUrl).href,
    new URL("/terms", siteUrl).href,
    new URL("/delete-account", siteUrl).href,
  ].map((url) => ({ url }));
}
