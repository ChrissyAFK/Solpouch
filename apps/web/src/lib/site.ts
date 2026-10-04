import type { Metadata } from "next";

// Set this to the deployed origin before sharing public social previews.
// Never infer production URLs from request headers or invent a deployment domain.
function configuredOrigin(): URL | undefined {
  const configured = process.env.SOLPOUCH_SITE_URL?.trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export const siteUrl = configuredOrigin();
const localHost =
  siteUrl &&
  (siteUrl.hostname === "localhost" ||
    siteUrl.hostname === "127.0.0.1" ||
    siteUrl.hostname === "[::1]" ||
    siteUrl.hostname.endsWith(".localhost"));
// Public landing-page indexing requires an explicit deployment setting.
export const allowIndexing =
  process.env.NODE_ENV === "production" &&
  !!siteUrl &&
  !localHost &&
  process.env.SOLPOUCH_ALLOW_INDEXING === "true";
export const siteDescription =
  "Manage budget pouches, review spending limits, and approve shopping orders with Solpouch.";
export const privateRobots: Metadata["robots"] = {
  index: false,
  follow: false,
  noarchive: true,
  nosnippet: true,
};

export function pageMetadata(
  title: string,
  description: string,
  privatePage = true,
): Metadata {
  const fullTitle = `${title} | Solpouch`;
  const image = {
    url: "/social-preview.png",
    width: 1200,
    height: 630,
    alt: "Solpouch — Pouches, spending limits, and orders",
  };
  return {
    // Tabs stay short; link previews below keep the page name.
    title: "Solpouch",
    description,
    robots:
      privatePage || !allowIndexing
        ? privateRobots
        : { index: true, follow: true },
    openGraph: {
      type: "website",
      siteName: "Solpouch",
      locale: "en_US",
      title: fullTitle,
      description,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [image],
    },
  };
}
