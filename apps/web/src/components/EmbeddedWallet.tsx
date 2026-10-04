"use client";

import { useEffect, useMemo, useRef } from "react";
import { PrivyProvider, usePrivy, useSubscribeToJwtAuthWithFlag } from "@privy-io/react-auth";
import {
  useCreateWallet,
  useSignAndSendTransaction,
  useSignMessage,
  useSignTransaction,
  useWallets,
} from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { api } from "@/lib/api";
import { useAuth } from "./AuthProvider";
import { linkWallet, setEmbeddedWallet, type Wallet } from "./WalletLink";

const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet";
const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const WS_URL = RPC_URL.replace(/^http/, "ws");
const CHAIN = `solana:${CLUSTER}` as "solana:devnet";
const HIDDEN = { uiOptions: { showWalletUIs: false } };

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const b of bytes) {
    if (b !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

function PrivyBridge() {
  const { user, sessionKey, loading, updateUser } = useAuth();
  const { ready, wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { ready: privyReady, authenticated } = usePrivy();
  const { createWallet } = useCreateWallet();
  const linked = useRef(false);
  const created = useRef(false);

  useSubscribeToJwtAuthWithFlag({
    isAuthenticated: !!user && !!sessionKey,
    isLoading: loading,
    getExternalJwt: async () => {
      try {
        return (await api.privyToken()).token;
      } catch {
        return undefined;
      }
    },
  });

  useEffect(() => {
    if (!privyReady || !authenticated || !ready || wallets.length > 0 || created.current) return;
    created.current = true;
    createWallet().catch((e) => console.warn("Built-in wallet creation failed", e));
  }, [privyReady, authenticated, ready, wallets.length, createWallet]);

  const privyWallet = ready ? wallets[0] : undefined;
  const address = privyWallet?.address;

  const adapter = useMemo<Wallet | undefined>(() => {
    if (!privyWallet || !address) return undefined;
    const publicKey = { toBase58: () => address };
    const toBytes = (tx: unknown) =>
      typeof (tx as { serialize?: unknown })?.serialize === "function"
        ? (tx as { serialize(o: object): Uint8Array }).serialize({
            requireAllSignatures: false,
            verifySignatures: false,
          })
        : (tx as Uint8Array);
    return {
      publicKey,
      connect: async () => ({ publicKey }),
      signMessage: async (message) => {
        const { signature } = await signMessage({ message, wallet: privyWallet, options: HIDDEN });
        return { signature };
      },
      signAndSendTransaction: async (tx) => {
        const { signature } = await signAndSendTransaction({
          transaction: toBytes(tx),
          wallet: privyWallet,
          chain: CHAIN,
          options: HIDDEN,
        });
        return { signature: base58(signature) };
      },
      signTransaction: async (tx) => {
        const { signedTransaction } = await signTransaction({
          transaction: toBytes(tx),
          wallet: privyWallet,
          options: HIDDEN,
        });
        const web3 = await import("@solana/web3.js");
        return web3.Transaction.from(signedTransaction);
      },
    };
  }, [privyWallet, address, signMessage, signTransaction, signAndSendTransaction]);

  useEffect(() => {
    if (!user || !sessionKey) {
      setEmbeddedWallet(undefined);
      linked.current = false;
      created.current = false;
      return;
    }
    setEmbeddedWallet(adapter);
    return () => setEmbeddedWallet(undefined);
  }, [adapter, user, sessionKey]);

  useEffect(() => {
    if (!user || !sessionKey || user.wallet || !adapter || linked.current) return;
    linked.current = true;
    linkWallet(adapter, updateUser, () => true).catch((e) =>
      console.warn("Built-in wallet auto-link failed", e),
    );
  }, [user, sessionKey, adapter, updateUser]);

  return null;
}

export default function EmbeddedWallet() {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const rpcs = useMemo(
    () => ({
      [CHAIN]: { rpc: createSolanaRpc(RPC_URL), rpcSubscriptions: createSolanaRpcSubscriptions(WS_URL) },
    }),
    [],
  );
  if (!appId) return null;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } },
        appearance: { walletChainType: "solana-only" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        solana: { rpcs: rpcs as any },
      }}
    >
      <PrivyBridge />
    </PrivyProvider>
  );
}
