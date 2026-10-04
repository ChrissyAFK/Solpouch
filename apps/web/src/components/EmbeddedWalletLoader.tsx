"use client";
import dynamic from "next/dynamic";

const EmbeddedWallet = dynamic(() => import("@/components/EmbeddedWallet"), { ssr: false });

export function EmbeddedWalletLoader() {
  return <EmbeddedWallet />;
}
