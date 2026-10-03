import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Shell } from "@/components/Shell";
import { pageMetadata, siteDescription, siteUrl } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  ...pageMetadata("Spending with limits", siteDescription, false),
  // Local fallback is only for development previews; canonical URLs require config.
  metadataBase: siteUrl ?? new URL("http://localhost:3000"),
  applicationName: "Solpouch",
  manifest: "/manifest.webmanifest",
  referrer: "strict-origin-when-cross-origin",
  ...(siteUrl
    ? {
        alternates: { canonical: siteUrl.href },
        openGraph: {
          ...pageMetadata("Spending with limits", siteDescription, false).openGraph,
          url: siteUrl.href,
        },
      }
    : {}),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#101014",
  colorScheme: "dark",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Render per request so Next can apply the CSP nonce provided by the proxy.
  await connection();
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
