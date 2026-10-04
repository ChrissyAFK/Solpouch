"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "./AuthProvider";
import { WalletLink } from "./WalletLink";
import { ErrorBanner, Notice, btnPrimary, btnSecondary, card, input, label } from "./ui";
import { api, errMsg, type StripeFundingConfig, type StripeFundingRequest } from "@/lib/api";
import { getToken } from "@/lib/session";
import { explorerTxUrl } from "@/lib/explorer";

class FundingUiError extends Error {}
const fundingError = (cause: unknown) => cause instanceof FundingUiError ? cause.message : errMsg(cause);
type Pending = { amountCad: string; idempotencyKey: string; id?: string };
function quote(amount: string, rate: string): string | null {
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || !/^\d+(\.\d{1,12})?$/.test(rate)) return null;
  const [whole, fraction = ""] = rate.split(".");
  const cents = BigInt(Math.round(Number(amount) * 100));
  const micros = cents * BigInt(whole + fraction) * 10000n / (10n ** BigInt(fraction.length));
  return `${micros / 1000000n}.${(micros % 1000000n).toString().padStart(6, "0")}`;
}
function safeCheckout(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.port || url.username || url.password) throw new FundingUiError("Invalid checkout destination. Check this request before trying again.");
  return url.href;
}
export function StripeFunding({ config }: { config: StripeFundingConfig }) {
  const { user, sessionKey } = useAuth();
  const storageKey = `solpouch.stripe:${user?.email ?? ""}:${user?.wallet ?? ""}`;
  const [amount, setAmount] = useState("25");
  const [pending, setPending] = useState<Pending | null>(null);
  const [request, setRequest] = useState<StripeFundingRequest | null>(null);
  const [history, setHistory] = useState<StripeFundingRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pollId, setPollId] = useState<string | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [ready, setReady] = useState(false);
  const alive = useRef(true);
  const running = useRef(false);
  const current = () => alive.current && getToken() === sessionKey;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let live = true;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as Pending;
        if (typeof saved.amountCad !== "string" || !/^\d+(\.\d{1,2})?$/.test(saved.amountCad) || typeof saved.idempotencyKey !== "string" || (saved.id !== undefined && typeof saved.id !== "string")) throw new FundingUiError("Saved funding request is invalid. Check funding history before continuing.");
        setPending(saved); setAmount(saved.amountCad); if (saved.id) setPollId(saved.id);
      }
      const session = new URLSearchParams(window.location.search).get("session_id");
      if (session) {
        if (!/^cs_test_[A-Za-z0-9]+$/.test(session)) throw new FundingUiError("Invalid checkout reference.");
        setPollId(session);
      }
    } catch (cause) { setError(fundingError(cause)); }
    setReady(true);
    api.stripeHistory().then(items => { if (live && current()) setHistory(items); }).catch(cause => { if (live && current()) setError(fundingError(cause)); });
    return () => { live = false; };
    // The parent remounts this workspace when the account or linked wallet changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  useEffect(() => {
    if (!pollId) return;
    let live = true;
    const controller = new AbortController();
    const deadline = Date.now() + 120000;
    let timer: ReturnType<typeof setTimeout>;
    setChecking(true); setTimedOut(false);
    const stop = setTimeout(() => { live = false; controller.abort(); clearTimeout(timer); if (current()) { setChecking(false); setTimedOut(true); } }, 120000);
    async function poll() {
      try {
        const next = await api.stripeFunding(pollId!, controller.signal);
        if (!live || !current()) return;
        if (next.wallet !== user?.wallet) throw new FundingUiError("This request belongs to a different linked wallet.");
        setRequest(next); setHistory(items => [next, ...items.filter(item => item.id !== next.id)]); setError(null);
        if (next.status === "expired" || next.status === "confirmed" || (next.status === "paid" && !config.mintEnabled)) { clearTimeout(stop); setChecking(false); return; }
      } catch (cause) { if (!live || !current()) return; setError(fundingError(cause)); }
      if (live && current() && Date.now() < deadline) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { live = false; controller.abort(); clearTimeout(timer); clearTimeout(stop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollId, pollAttempt, sessionKey, config.mintEnabled, user?.wallet]);
  async function start(event: React.FormEvent) {
    event.preventDefault();
    if ((pollId && !pending) || running.current || !current() || !config.configured || !user?.wallet || !ready) return;
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) < 5 || Number(amount) > 200) { setError("Enter an amount from $5 to $200 CAD, with at most two decimal places."); return; }
    const body = pending ?? { amountCad: Number(amount).toFixed(2), idempotencyKey: crypto.randomUUID() };
    running.current = true; setBusy(true); setError(null); setPending(body);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(body));
      const result = await api.stripeCheckout({ amountCad: body.amountCad, idempotencyKey: body.idempotencyKey });
      if (!current()) return;
      if (result.request.wallet !== user.wallet) throw new FundingUiError("The checkout wallet does not match your linked wallet.");
      const saved = { ...body, id: result.request.id };
      sessionStorage.setItem(storageKey, JSON.stringify(saved)); setPending(saved); setRequest(result.request);
      if (result.url && result.request.status === "checkout_ready") window.location.assign(safeCheckout(result.url));
      else { setPollId(result.request.id); setPollAttempt(n => n + 1); }
    } catch (cause) { if (current()) setError(fundingError(cause)); }
    finally { running.current = false; if (current()) setBusy(false); }
  }
  function another() {
    try { sessionStorage.removeItem(storageKey); } catch { setError("Could not clear the previous request. Reload before continuing."); return; }
    window.history.replaceState(null, "", window.location.pathname);
    setPending(null); setRequest(null); setPollId(null); setError(null); setTimedOut(false);
  }
  const preview = Number(amount) >= 5 && Number(amount) <= 200 ? quote(amount, config.usdPerCad) : null;
  const confirmed = request?.status === "confirmed" && Boolean(explorerTxUrl(request.txSignature));
  const expired = request?.status === "expired";
  const paid = request?.status === "paid" || request?.status === "confirmed";
  return <div className="space-y-6">
    <header><p className="text-sm text-[var(--muted)]">Wallet funding</p><h1 className="text-3xl font-semibold">Add money</h1><p className="mt-2 text-[var(--muted)]">Fund your linked wallet, then choose a pouch to top up.</p></header>
    <section className={card}><h2 className="text-lg font-semibold">Linked wallet</h2><div className="my-3"><WalletLink /></div>
      <ErrorBanner message={error} />
      {!config.configured && <Notice>Card funding is not configured yet.</Notice>}
      {request && <div role="status" className="my-4 space-y-2"><strong>{confirmed ? `Payment received, ${request.usdcAmount} USDC added` : paid ? "Payment received" : expired ? "Checkout expired. No payment was received." : "Processing payment"}</strong><p>{request.amountCad} CAD · {request.usdcAmount} USDC</p>{paid && !confirmed && <p>{config.mintEnabled ? "The wallet transfer is still being checked. No confirmed deposit yet." : "Wallet crediting is disabled. No funds were added."}</p>}{confirmed && <a className="underline" href={explorerTxUrl(request.txSignature)!} target="_blank" rel="noopener noreferrer">View mint transaction ↗</a>}</div>}
      {checking && <p role="status">Checking payment status…</p>}
      {timedOut && <Notice>Status checks paused after two minutes. Your request is saved. Check again before making another payment.</Notice>}
      <form onSubmit={start} className="space-y-4 mt-4">
        <fieldset disabled={busy || Boolean(pending) || Boolean(pollId)} className="space-y-3"><label className={label}>Amount · CAD<input className={input} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></label><div className="flex gap-2">{[10,25,50].map(value => <button key={value} type="button" className={btnSecondary} onClick={() => setAmount(String(value))}>${value}</button>)}</div></fieldset>
        {!request && preview && <p>{config.mintEnabled ? `You’ll get ${preview} USDC.` : `Quote: ${preview} USDC.`}</p>}
        {!config.mintEnabled && <p>Wallet delivery is disabled; this test payment will not add funds.</p>}
        <p className="text-sm text-[var(--muted)]">Test card payments · 4242 4242 4242 4242, any future expiry and any CVC.</p>
        {!user?.wallet && <p>Link a wallet before continuing.</p>}
        {!paid && !expired && (!pollId || pending) && <button className={btnPrimary} disabled={busy || checking || !ready || !config.configured || !user?.wallet || !preview}>{busy ? "Preparing checkout…" : pending ? "Retry the same checkout" : "Continue to card checkout"}</button>}
        {(pollId || request) && !checking && <button type="button" className={btnSecondary} onClick={() => { setPollId(request?.id ?? pollId); setPollAttempt(n => n + 1); }}>Check status</button>}
        {(expired || (paid && (confirmed || !config.mintEnabled))) && <button type="button" className={btnSecondary} onClick={another}>Start another request</button>}
        {confirmed && <Link className={btnPrimary} href="/dashboard">Top up a pouch</Link>}
      </form>
    </section>
    <section className={card}><h2 className="text-lg font-semibold">Funding history</h2>{!history.length && <p className="mt-3 text-[var(--muted)]">No funding requests yet.</p>}<ul className="divide-y divide-[var(--line)]">{history.map(item => <li key={item.id} className="py-3 flex flex-wrap justify-between gap-3"><span>{item.amountCad} CAD · {item.usdcAmount} USDC · {item.status === "confirmed" && explorerTxUrl(item.txSignature) ? "Transfer confirmed" : item.status === "paid" || item.status === "confirmed" ? "Payment received" : item.status === "expired" ? "Expired" : "Pending"}</span><button className={btnSecondary} disabled={busy || checking} onClick={() => { setPollId(item.id); setPollAttempt(n => n + 1); }}>Check request</button></li>)}</ul></section>
  </div>;
}
