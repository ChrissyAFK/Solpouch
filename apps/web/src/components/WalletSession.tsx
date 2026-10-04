"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { BACKEND_URL, resetSessionRequests, SESSION_EXPIRED_EVENT } from "@/lib/api";
import styles from "./WalletSession.module.css";

const SESSION_CHANGE_KEY = "solpouch:session-change";
function announceSessionChange() {
  try { localStorage.setItem(SESSION_CHANGE_KEY, `${Date.now()}:${Math.random()}`); } catch { /* Focus checks also verify the cookie session. */ }
}

type Wallet = {
  publicKey?: { toBase58(): string };
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  on?(event: string, listener: () => void): void;
  removeListener?(event: string, listener: () => void): void;
};
function injectedWallet(): Wallet | undefined {
  const browser = window as unknown as { solana?: Wallet; phantom?: { solana?: Wallet }; solflare?: Wallet };
  return browser.phantom?.solana ?? browser.solana ?? browser.solflare;
}
type Session = {
  wallet: string | null;
  checking: boolean;
  busy: boolean;
  error: string | null;
  epoch: number;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
};
const Context = createContext<Session | null>(null);
export function useWalletSession() {
  const context = useContext(Context);
  if (!context) throw new Error("Wallet session is missing");
  return context;
}
async function authRequest(path: string, body?: unknown, method?: string) {
  const response = await fetch(`${BACKEND_URL}/auth/${path}`, {
    credentials: "include",
    cache: "no-store",
    method: method ?? (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "Could not verify your session. Please try again.");
  return data;
}
export function WalletSessionProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const revision = useRef(0);
  const operation = useRef(false);
  const activeWallet = useRef<string | null>(null);
  function clearSession() {
    revision.current++;
    resetSessionRequests();
    activeWallet.current = null;
    setWallet(null);
    setEpoch((n) => n + 1);
    setChecking(false);
  }
  useEffect(() => {
    let disposed = false;
    const version = revision.current;
    void authRequest("session").then((data) => {
      if (!disposed && version === revision.current && typeof data?.wallet === "string") {
        activeWallet.current = data.wallet;
        setWallet(data.wallet);
      }
    }).catch(() => {}).finally(() => { if (!disposed) setChecking(false); });
    const expired = () => {
      clearSession();
      setError("Your session ended. Sign in again to continue.");
    };
    const changedElsewhere = (event: StorageEvent) => {
      if (event.key !== SESSION_CHANGE_KEY) return;
      clearSession();
      setError("Your session changed in another tab. Sign in again to continue.");
    };
    const checkOnFocus = () => {
      if (!activeWallet.current || operation.current) return;
      // Hide old account data while checking the shared browser cookie.
      clearSession();
      setChecking(true);
      const expectedRevision = revision.current;
      void authRequest("session").then((data) => {
        if (!disposed && expectedRevision === revision.current && typeof data?.wallet === "string") {
          activeWallet.current = data.wallet;
          setWallet(data.wallet);
          setError(null);
        }
      }).catch(() => {
        if (!disposed && expectedRevision === revision.current) setError("Your session could not be verified. Sign in again to continue.");
      }).finally(() => { if (!disposed && expectedRevision === revision.current) setChecking(false); });
    };
    window.addEventListener("storage", changedElsewhere);
    window.addEventListener("focus", checkOnFocus);
    const provider = injectedWallet();
    const changed = () => {
      if (activeWallet.current && provider?.publicKey?.toBase58() !== activeWallet.current) {
        void signOut();
      }
    };
    const disconnected = () => { if (activeWallet.current) void signOut(); };
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    provider?.on?.("accountChanged", changed);
    provider?.on?.("disconnect", disconnected);
    return () => {
      disposed = true;
      window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
      window.removeEventListener("storage", changedElsewhere);
      window.removeEventListener("focus", checkOnFocus);
      provider?.removeListener?.("accountChanged", changed);
      provider?.removeListener?.("disconnect", disconnected);
    };
  }, []);
  async function signIn() {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    const version = revision.current;
    try {
      const provider = injectedWallet();
      if (!provider?.signMessage) throw new Error("Open this site in a Phantom or Solflare wallet browser, or install its browser extension, then try again.");
      const { publicKey } = await provider.connect();
      const address = publicKey.toBase58();
      const challenge = await authRequest("challenge", { wallet: address });
      if (typeof challenge?.id !== "string" || typeof challenge?.message !== "string") throw new Error("Could not start sign-in. Please try again.");
      const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
      if (version !== revision.current || provider.publicKey?.toBase58() !== address) throw new Error("Your wallet changed during sign-in. Please try again.");
      if (signed.signature.length !== 64) throw new Error("The wallet returned an invalid signature. Please try again.");
      const signature = btoa(String.fromCharCode(...signed.signature));
      const session = await authRequest("verify", { id: challenge.id, signature });
      if (version !== revision.current || provider.publicKey?.toBase58() !== address) {
        await authRequest("logout", undefined, "POST");
        throw new Error("Your wallet changed during sign-in. Please try again.");
      }
      if (session?.wallet !== address) throw new Error("Could not verify this wallet. Please try again.");
      resetSessionRequests();
      activeWallet.current = address;
      setWallet(address);
      announceSessionChange();
      setEpoch((n) => n + 1);
    } catch (cause) {
      if (version === revision.current) setError(cause instanceof Error ? cause.message : "Sign-in was cancelled. Please try again.");
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  async function signOut() {
    clearSession();
    announceSessionChange();
    operation.current = true;
    setBusy(true);
    setError(null);
    try { await authRequest("logout", undefined, "POST"); }
    catch { setError("The server could not confirm sign-out. Your view is cleared; retry signing out before leaving a shared device."); }
    finally { operation.current = false; setBusy(false); }
  }
  return <Context.Provider value={{ wallet, checking, busy, error, epoch, signIn, signOut }}>{children}</Context.Provider>;
}
export function WalletGate({ children }: { children: React.ReactNode }) {
  const session = useWalletSession();
  if (session.wallet) return <div key={session.epoch}>{children}</div>;
  return <section className={styles.gate} aria-busy={session.checking || session.busy}>
    <span className={styles.eyebrow}>Your workspace</span>
    <h1>{session.checking ? "Checking your session…" : "Sign in with your wallet"}</h1>
    <p>View and manage the pouches linked to your wallet. Signing a message proves that you own the address. It does not send a payment.</p>
    {session.error && <p role="alert" className={styles.error}>{session.error}</p>}
    {!session.checking && <button type="button" disabled={session.busy} onClick={() => void session.signIn()}>{session.busy ? "Waiting for wallet…" : "Connect and sign in"}</button>}
    {session.error?.includes("sign-out") && <button type="button" disabled={session.busy} onClick={() => void session.signOut()}>Retry sign-out</button>}
    <p className={styles.hint}>Use Phantom or Solflare. Never enter a recovery phrase on this site.</p>
  </section>;
}
export function WalletAccount() {
  const session = useWalletSession();
  if (!session.wallet) return null;
  return <div className={styles.account}>
    <span title={session.wallet}>{session.wallet.slice(0, 4)}…{session.wallet.slice(-4)}</span>
    <button type="button" disabled={session.busy} onClick={() => void session.signOut()}>Sign out</button>
  </div>;
}
export function PaymentMode() {
  const [label, setLabel] = useState("Payment mode unavailable");
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    void fetch(`${BACKEND_URL}/health`, { credentials: "include", cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      if (!controller.signal.aborted) setLabel(data.mode === "mock" ? "Demo · simulated payments" : data.mode === "chain" && typeof data.network === "string" ? `Solana · ${data.network}` : "Payment mode unavailable");
    }).catch(() => {}).finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, []);
  return <span className="demo-label">{label}</span>;
}
