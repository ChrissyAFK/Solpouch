"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { WalletLink } from "@/components/WalletLink";
import { RowsSkeleton } from "@/components/Skeletons";
import { api, errMsg, type FundingConfig, type FundingRequest } from "@/lib/api";
import { getToken } from "@/lib/session";
import { ErrorBanner, Notice, btnPrimary, btnSecondary, card, input, label } from "@/components/ui";

const labels: Record<FundingRequest["status"], string> = { created: "Preparing checkout", session_ready: "Checkout ready", session_uncertain: "Checkout needs checking", processing: "Provider is processing", provider_completed: "Provider completed · transfer unverified", sandbox_completed: "Test completed · no real funds", confirmed: "Transfer confirmed", failed: "Failed", cancelled: "Cancelled", refunded: "Refunded" };
export default function FundingPage() {
  const { user, sessionKey } = useAuth();
  return <FundingWorkspace key={`${sessionKey}:${user?.wallet ?? ""}`} />;
}
function FundingWorkspace() {
  const { user, sessionKey } = useAuth();
  const [config, setConfig] = useState<FundingConfig | null>(null);
  const [requests, setRequests] = useState<FundingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);
  const pendingId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [country, setCountry] = useState<"US" | "CA">("US");
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkout, setCheckout] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const mounted = useRef(true);
  const pending = useRef<{ country: "US" | "CA"; direction: "BUY" | "SELL"; amount: string; idempotencyKey: string } | null>(null);
  const storageKey = `solpouch.funding:${user?.email ?? ""}:${user?.wallet ?? ""}`;
  const running = useRef(false);
  const revision = useRef(0);
  const current = useCallback(() => mounted.current && getToken() === sessionKey, [sessionKey]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  const refresh = useCallback(async () => {
    const generation = ++revision.current;
    setLoading(true); setError(null);
    try {
      const [next, list] = await Promise.allSettled([api.fundingConfig(), api.fundingRequests()]);
      if (!current() || generation !== revision.current) return;
      if (next.status === "fulfilled") setConfig(next.value); else setError(errMsg(next.reason));
      if (list.status === "fulfilled") {
        setRequests(list.value); setHistoryError(null);
        const saved = list.value.find(item => item.id === pendingId.current);
        if (saved && ["failed", "cancelled", "refunded", "sandbox_completed", "confirmed"].includes(saved.status)) { setTerminal(true); setCheckout(null); }
      } else setHistoryError(errMsg(list.reason));
    } catch (cause) { if (current() && generation === revision.current) setError(errMsg(cause)); }
    finally { if (current() && generation === revision.current) setLoading(false); }
  }, [current]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if ((saved.country !== "US" && saved.country !== "CA") || (saved.direction !== "BUY" && saved.direction !== "SELL") || typeof saved.amount !== "string" || typeof saved.idempotencyKey !== "string") throw new Error();
      pendingId.current = sessionStorage.getItem(`${storageKey}:id`);
      pending.current = saved; setCountry(saved.country); setDirection(saved.direction); setAmount(saved.amount); setUncertain(true);
    } catch { setError("The saved funding request could not be read. Check your funding history before continuing."); setUncertain(true); }
  }, [storageKey]);
  const region = config?.countries.find(item => item.country === country);
  const enabled = config?.configured && (direction === "BUY" ? region?.buyEnabled : region?.sellEnabled);
  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (running.current || !enabled || !user?.wallet || !current()) return;
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0) { setError("Enter an amount greater than zero with at most two decimal places."); return; }
    running.current = true; setBusy(true); setError(null); setCheckout(null);
    const body = pending.current ?? { country, direction, amount: Number(amount).toFixed(2), idempotencyKey: crypto.randomUUID() };
    pending.current = body;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(body));
      const result = await api.startFunding(body);
      if (!current()) return;
      pendingId.current = result.request.id;
      sessionStorage.setItem(`${storageKey}:id`, result.request.id);
      setTerminal(["failed", "cancelled", "refunded", "sandbox_completed", "confirmed"].includes(result.request.status));
      setRequests(list => [result.request, ...list.filter(item => item.id !== result.request.id)]);
      if (result.widgetUrl) {
        const url = new URL(result.widgetUrl);
        if (url.protocol !== "https:" || url.hostname !== "global-stg.transak.com" || url.username || url.password || url.port || !url.searchParams.get("sessionId")) throw new Error("Invalid checkout destination");
        setCheckout(url.href);
      }
      if (!result.widgetUrl && result.request.status === "session_ready") setError("Checkout cannot be reopened. Check status before creating another request; contact support if you already paid.");
      setUncertain(!result.widgetUrl && !["failed", "cancelled", "refunded", "sandbox_completed", "confirmed"].includes(result.request.status));
      // Keep the key until the user deliberately changes inputs; retries cannot create a second order.
    } catch (cause) { if (current()) { setError(errMsg(cause)); setUncertain(true); } }
    finally { running.current = false; if (current()) setBusy(false); }
  }
  async function reconcile(id: string) {
    if (running.current || !current()) return;
    running.current = true; setBusy(true); setError(null);
    try { const next = await api.reconcileFunding(id); if (current()) { setRequests(list => list.map(item => item.id === id ? next : item)); if (pendingId.current === id && ["failed", "cancelled", "refunded", "sandbox_completed", "confirmed"].includes(next.status)) { setTerminal(true); setCheckout(null); } } }
    catch (cause) { if (current()) setError(errMsg(cause)); }
    finally { running.current = false; if (current()) setBusy(false); }
  }
  function change() { try { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(`${storageKey}:id`); } catch {} setTerminal(false); pendingId.current = null; pending.current = null; setCheckout(null); setUncertain(false); setError(null); }
  return <div className="space-y-6">
    <header><p className="text-sm text-[var(--muted)]">Wallet funding</p><h1 className="text-3xl font-semibold">Add money or cash out</h1><p className="mt-2 text-[var(--muted)]">Choose US dollars or Canadian dollars. Funds belong to your linked wallet; this does not add money to a pouch.</p></header>
    <Notice><strong>Test environment · no real bank transfers</strong><p>{config?.notice ?? "This flow uses the provider’s sandbox. Mainnet funding is not enabled."}</p></Notice>
    <ErrorBanner message={error} />
    {loading ? <RowsSkeleton /> : !config ? <button className={btnSecondary} onClick={() => void refresh()}>Retry funding setup</button> : <section className={card} aria-label="Funding options">
      <h2 className="text-lg font-semibold">Linked wallet</h2><div className="my-3"><WalletLink /></div>
      <form onSubmit={start} className="space-y-4">
        <fieldset disabled={busy || uncertain || Boolean(checkout) || terminal} className="space-y-4">
          <label className={label}>Country<select aria-label="Country" className={input} value={country} onChange={event => { change(); setCountry(event.target.value as "US" | "CA"); }}><option value="US">United States · USD</option><option value="CA">Canada · CAD</option></select></label>
          <label className={label}>Action<select aria-label="Action" className={input} value={direction} onChange={event => { change(); setDirection(event.target.value as "BUY" | "SELL"); }}><option value="BUY">Add money to wallet</option><option value="SELL">Cash out from wallet</option></select></label>
          <label className={label}>Amount · {direction === "SELL" ? "USDC" : region?.currency ?? (country === "US" ? "USD" : "CAD")}<input className={input} inputMode="decimal" value={amount} onChange={event => { change(); setAmount(event.target.value); }} placeholder="0.00" /></label>
        </fieldset>
        <p className="text-sm text-[var(--muted)]">The provider shows the current quote, fees, available payment methods and identity checks before you approve. Cashing out may require a wallet transfer after reviewing the provider’s instructions.</p>
        {!user?.wallet && <p>Link a wallet before continuing.</p>}
        {!enabled && <p role="status">{direction === "BUY" ? "Adding money" : "Cashing out"} in {country === "CA" ? "Canada" : "the United States"} is not configured yet.</p>}
        {terminal ? <button type="button" className={btnSecondary} onClick={event => { event.preventDefault(); change(); }}>Start another request</button> : checkout ? <a className={btnPrimary} href={checkout} target="_blank" rel="noopener noreferrer" onClick={() => { setCheckout(null); setUncertain(true); setError("Checkout opened. Check the existing request below; the checkout link is single-use."); }}>Open test checkout ↗</a> : <button className={btnPrimary} disabled={busy || !enabled || !user?.wallet || !amount}>{busy ? "Checking…" : uncertain ? "Retry the same request" : "Continue to test checkout"}</button>}
        {uncertain && !terminal && <p role="status">The result needs checking. Retry uses the same request; check its status below before starting another.</p>}
        {checkout && <p className="text-sm">Returning from checkout does not confirm payment. Use Check status below.</p>}
      </form>
    </section>}
    <section className={card} aria-label="Funding history"><div className="flex justify-between gap-3"><h2 className="text-lg font-semibold">Funding history</h2><button className={btnSecondary} disabled={busy || loading} onClick={() => void refresh()}>Refresh</button></div>
      <ErrorBanner message={historyError} />
      {!loading && !historyError && requests.length === 0 && <p className="mt-4 text-[var(--muted)]">No funding requests yet.</p>}
      <ul className="divide-y divide-[var(--line)]">{requests.map(item => <li key={item.id} className="py-4 space-y-2"><div className="flex flex-wrap justify-between gap-2"><strong>{item.direction === "BUY" ? "Add money" : "Cash out"} · {item.amount} {item.direction === "SELL" ? "USDC" : item.currency}</strong><span>{labels[item.status]}</span></div><p className="text-sm break-all">Wallet: {item.wallet}</p><p className="text-sm text-[var(--muted)]">{new Date(item.createdAt).toLocaleString()} · Test request</p>{item.message && <p>{item.message}</p>}{item.txSignature && <p className="text-sm break-all">Transfer reference: {item.txSignature}</p>}<button className={btnSecondary} disabled={busy} onClick={() => void reconcile(item.id)}>Check status</button></li>)}</ul>
    </section>
  </div>;
}
