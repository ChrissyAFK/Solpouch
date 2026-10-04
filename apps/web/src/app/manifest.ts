import type { MetadataRoute } from "next";
import { siteDescription } from "@/lib/site";

const shortcutIcon = {
  src: "/icons/icon-192.png",
  sizes: "192x192",
  type: "image/png",
};

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Solpouch",
    short_name: "Solpouch",
    description: siteDescription,
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    categories: ["finance", "shopping"],
    shortcuts: [
      { name: "New order", url: "/order", icons: [shortcutIcon] },
      { name: "Pouches", url: "/pouches", icons: [shortcutIcon] },
      { name: "Orders", url: "/orders", icons: [shortcutIcon] },
    ],
    background_color: "#101014",
    theme_color: "#101014",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
