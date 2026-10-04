import type { Metadata } from "next";
import { RequireAuth } from "@/components/AuthProvider";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = {
  ...pageMetadata(
    "New order",
    "Build a shopping cart, review matched items, and approve an order from your Solpouch budget.",
  ),
  // Order IDs and account-specific query strings are never canonical or social URLs.
  alternates: { canonical: null },
};

export default function OrderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequireAuth>{children}</RequireAuth>;
}
