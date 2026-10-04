import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import { AuthProvider } from "@/components/AuthProvider";
import { PrefsSync } from "@/components/PrefsSync";
import { ServiceWorker } from "@/components/ServiceWorker";
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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f1ea" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d10" },
  ],
  colorScheme: "dark light",
};

// Runs before first paint so a saved theme, motion or text-size choice never flashes.
const EARLY_PREFS = `(function(){try{var p=JSON.parse(localStorage.getItem("solpouch.prefs"));if(!p)return;var d=document.documentElement;if(p.theme==="light"||p.theme==="dark")d.setAttribute("data-theme",p.theme);if(p.motion==="reduced")d.setAttribute("data-motion","reduced");if(p.textSize==="large")d.setAttribute("data-text","large");}catch(e){}})();`;

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
      suppressHydrationWarning
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: EARLY_PREFS }} />
      </head>
      <body>
        <PrefsSync />
        <ServiceWorker />
        <AuthProvider nonce={nonce}>
          <Shell>{children}</Shell>
        </AuthProvider>
      </body>
    </html>
  );
}
