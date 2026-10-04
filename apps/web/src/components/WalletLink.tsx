"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiRequestError, errMsg } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useAuth } from "./AuthProvider";
import styles from "./WalletLink.module.css";

type Wallet = {
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signMessage?(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  on?(event: string, listener: () => void): void;
  removeListener?(event: string, listener: () => void): void;
};
function injectedWallet(): Wallet | undefined {
  const browser = window as unknown as { solana?: Wallet; phantom?: { solana?: Wallet }; solflare?: Wallet };
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
class LinkProblem extends Error {}

/** Links a Solana wallet to the signed-in account by signing a challenge (proves ownership; moves no money). */
export function WalletLink() {
  const { user, sessionKey, updateUser } = useAuth();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linking = useRef(false);
  const linked = user?.wallet;

  useEffect(() => {
    const provider = injectedWallet();
    setAvailable(Boolean(provider));
    // A different account in the extension no longer matches the signed proof.
    const changed = () => {
      if (!linking.current && linked && provider?.publicKey?.toBase58() !== linked)
        setError("Your wallet extension switched accounts. Top-ups still use the linked wallet; unlink it to link another.");
    };
    provider?.on?.("accountChanged", changed);
    return () => provider?.removeListener?.("accountChanged", changed);
  }, [linked]);

  async function link() {
    if (linking.current || !sessionKey) return;
    const provider = injectedWallet();
    if (!provider?.signMessage) {
      setAvailable(false);
      return;
    }
    const token = sessionKey;
    linking.current = true;
    setBusy(true);
    setError(null);
    try {
      const { publicKey } = await provider.connect();
      const address = publicKey.toBase58();
      const challenge = await api.walletChallenge(address);
      const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
      if (provider.publicKey?.toBase58() !== address) throw new LinkProblem("Your wallet changed while linking. Try again.");
      if (signed.signature.length !== 64) throw new LinkProblem("The wallet returned an invalid signature. Try again.");
      const { user: next } = await api.walletVerify(challenge.id, toBase64(signed.signature));
      // Ignore the result if the person signed out or switched accounts meanwhile.
      if (getToken() === token) updateUser({ wallet: next.wallet }, token);
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError ? errMsg(cause)
          : cause instanceof LinkProblem ? cause.message
          : "Linking was cancelled in the wallet. Try again.",
      );
    } finally {
      linking.current = false;
      setBusy(false);
    }
  }
  async function unlink() {
    if (!sessionKey) return;
    const token = sessionKey;
    setBusy(true);
    setError(null);
    try {
      await api.unlinkWallet();
      if (getToken() === token) updateUser({ wallet: undefined }, token);
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
          <span className={`num ${styles.addr}`} title={linked}>{shortAddress(linked)}</span>
          <button type="button" className={styles.link} disabled={busy} onClick={() => void unlink()}>
            Unlink
          </button>
        </div>
      ) : available === false ? (
        <p className={styles.hint}>
          No wallet found. Install{" "}
          <a href="https://phantom.app" target="_blank" rel="noreferrer">Phantom</a>{" "}
          or Solflare, then reload.
        </p>
      ) : (
        <button type="button" className={styles.btn} disabled={busy || available === null} onClick={() => void link()}>
          {busy ? "Waiting for wallet…" : "Link wallet"}
        </button>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
