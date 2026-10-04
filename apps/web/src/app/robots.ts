import type { MetadataRoute } from "next";
import { allowIndexing, siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  if (!allowIndexing || !siteUrl)
    return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/order", "/profile", "/pouches", "/orders", "/*?*"],
    },
    sitemap: new URL("/sitemap.xml", siteUrl).href,
  };
}
