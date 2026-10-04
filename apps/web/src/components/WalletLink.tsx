"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiRequestError, errMsg } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useAuth } from "./AuthProvider";
import styles from "./WalletLink.module.css";

export type Wallet = {
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signAndSendTransaction?(tx: unknown): Promise<{ signature: string }>;
  signTransaction?(tx: unknown): Promise<unknown>;
  signMessage?(
    message: Uint8Array,
    encoding?: string,
  ): Promise<{ signature: Uint8Array }>;
  on?(event: string, listener: () => void): void;
  removeListener?(event: string, listener: () => void): void;
};
export function injectedWallet(): Wallet | undefined {
  const browser = window as unknown as {
    solana?: Wallet;
    phantom?: { solana?: Wallet };
    solflare?: Wallet;
  };
  return browser.phantom?.solana ?? browser.solana ?? browser.solflare;
}
function toBase64(bytes: Uint8Array) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
export function shortAddress(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** Links a Solana wallet to the signed-in account by signing a challenge (proves ownership; moves no money). */
export function WalletLink() {
  const { user, updateUser, sessionKey } = useAuth();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linking = useRef(false);
  const linked = user?.wallet;

  useEffect(() => {
    setAvailable(Boolean(injectedWallet()));
    const provider = injectedWallet();
    // A different account in the extension means the signed proof no longer matches: ask to link again.
    const changed = () => {
      if (!linking.current && linked && provider?.publicKey?.toBase58() !== linked)
        setError("Your wallet account changed. Unlink and link it again.");
    };
    provider?.on?.("accountChanged", changed);
    return () => provider?.removeListener?.("accountChanged", changed);
  }, [linked]);

  async function link() {
    if (linking.current || !sessionKey) return;
    const token = sessionKey;
    const provider = injectedWallet();
    if (!provider?.signMessage) {
      setAvailable(false);
      return;
    }
    linking.current = true;
    setBusy(true);
    setError(null);
    try {
      const { publicKey } = await provider.connect();
      if (getToken() !== token) return;
      const address = publicKey.toBase58();
      const challenge = await api.walletChallenge(address);
      if (getToken() !== token) return;
      const signed = await provider.signMessage(
        new TextEncoder().encode(challenge.message),
        "utf8",
      );
      if (getToken() !== token) return;
      if (provider.publicKey?.toBase58() !== address)
        throw new Error("Your wallet changed while linking. Try again.");
      if (signed.signature.length !== 64)
        throw new Error("The wallet returned an invalid signature. Try again.");
      const { user: next } = await api.walletVerify(
        challenge.id,
        toBase64(signed.signature),
      );
      updateUser({ wallet: next.wallet ?? address }, token);
    } catch (cause) {
      const rejected =
        (cause as { code?: unknown } | null)?.code === 4001 ||
        (cause instanceof Error && /reject|cancel|denied/i.test(cause.message));
      setError(
        cause instanceof ApiRequestError
          ? errMsg(cause)
          : rejected
            ? "Linking was cancelled in the wallet. Try again."
            : cause instanceof Error
              ? cause.message
              : errMsg(cause),
      );
    } finally {
      linking.current = false;
      setBusy(false);
    }
  }
  async function unlink() {
    if (busy || !sessionKey) return;
    const token = sessionKey;
    setBusy(true);
    setError(null);
    try {
      await api.unlinkWallet();
      updateUser({ wallet: undefined }, token);
    } catch (cause) {
      setError(errMsg(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      {linked ? (
        <div className={styles.row}>
          <span className={`num ${styles.addr}`} title={linked}>
            {shortAddress(linked)}
          </span>
          <button
            type="button"
            className={styles.link}
            disabled={busy}
            onClick={() => void unlink()}
          >
            Unlink
          </button>
        </div>
      ) : available === false ? (
        <div className={styles.missing}>
          <p className={styles.hint}>
            No Solana wallet in this browser. Install one, then reload this page.
          </p>
          <div className={styles.row}>
            <a className={styles.btn} href="https://phantom.app/download" target="_blank" rel="noreferrer">
              Get Phantom <span aria-hidden="true">↗</span>
            </a>
            <a className={styles.btn} href="https://solflare.com/download" target="_blank" rel="noreferrer">
              Get Solflare <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.btn}
          disabled={busy || available === null}
          onClick={() => void link()}
        >
          {busy ? "Waiting for wallet…" : "Link wallet"}
        </button>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
