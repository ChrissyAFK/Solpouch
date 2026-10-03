import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = {
  ...pageMetadata(
    "Pouch details",
    "Review a Solpouch budget, manage its spending rules, and follow order activity.",
  ),
  // Do not place private pouch names, balances, or identifiers in metadata.
  alternates: { canonical: null },
};

export default function PouchLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
