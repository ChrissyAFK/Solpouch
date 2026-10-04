import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import { AuthProvider } from "@/components/AuthProvider";
import { Shell } from "@/components/Shell";
import { pageMetadata, siteDescription, siteUrl } from "@/lib/site";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  variable: "--font-archivo",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  ...pageMetadata("Spending with limits", siteDescription, false),
  // Short tab title; link previews keep the tagline from pageMetadata.
  title: "Solpouch",
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
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${archivo.variable} ${jetbrains.variable}`}
    >
      <body>
        <AuthProvider nonce={nonce}>
          <Shell>{children}</Shell>
        </AuthProvider>
      </body>
    </html>
  );
}
