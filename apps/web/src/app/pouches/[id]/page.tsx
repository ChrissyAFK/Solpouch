"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Merchant, Order, Pouch, SpendPoint, TopUp } from "@solpouch/shared";
import { toMicros, toUsdc } from "@solpouch/shared";
import { api, errMsg } from "@/lib/api";
import { PouchForm } from "@/components/PouchForm";
import { ErrorBanner, Notice, Progress, btnPrimary, btnSecondary, card, input, label, usd } from "@/components/ui";

function TopUpSection({ pouch, onDone }: { pouch: Pouch; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [topup, setTopup] = useState<TopUp | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const readyAt = topup ? new Date(topup.readyAt).getTime() : 0;
  const remaining = Math.max(0, readyAt - now);
  const ready = topup != null && remaining === 0;
  const fmt = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 3600) > 0 ? Math.floor(s / 3600) + "h " : ""}${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
  };

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setDone(false);
    try {
      setTopup(await api.startTopUp({ pouchId: pouch.id, amount: toMicros(Number(amount)), reason: reason.trim() }));
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }
  async function complete() {
    if (!topup) return;
    setBusy(true); setError(null);
    try {
      await api.completeTopUp(topup.id);
      setTopup(null); setAmount(""); setReason(""); setDone(true); onDone();
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  return (
    <section className={card}>
      <h2 className="text-2xl font-bold">Add money</h2>
      <p className="mt-1 text-lg">Pouches are meant to run out. Adding money takes a reason and a waiting period, on purpose.</p>
      <ErrorBanner message={error} />
      {done && <Notice>Top-up complete. Money added.</Notice>}
      {!topup ? (
        <form onSubmit={start} className="mt-4 space-y-4">
          <div>
            <label className={label} htmlFor="tu-amt">Amount ($)</label>
            <input id="tu-amt" className={input} required type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label className={label} htmlFor="tu-reason">Why do you need more? (required, at least 10 characters)</label>
            <textarea id="tu-reason" className={input} required minLength={10} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <button className={btnPrimary} disabled={busy || reason.trim().length < 10 || !(Number(amount) > 0)} type="submit">Start top-up</button>
        </form>
      ) : (
        <div className="mt-4 space-y-3" aria-live="polite">
          <p className="text-lg">Top-up of <b>{usd(toUsdc(topup.amount))}</b> started. Reason: &ldquo;{topup.reason}&rdquo;</p>
          <p className="text-3xl font-extrabold">{ready ? "Ready" : `Cooling down: ${fmt(remaining)}`}</p>
          <button className={btnPrimary} disabled={!ready || busy} onClick={complete}>Complete top-up</button>
        </div>
      )}
    </section>
  );
}

export default function PouchDetail() {
  const { id } = useParams<{ id: string }>();
  const [pouch, setPouch] = useState<Pouch | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [spend, setSpend] = useState<SpendPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, m, o, s] = await Promise.all([api.pouch(id), api.merchants(), api.orders(id), api.spend(id, "day")]);
      setPouch(p); setMerchants(m); setOrders(o); setSpend(s); setError(null);
    } catch (e) { setError(errMsg(e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (!pouch) return <div><ErrorBanner message={error} />{!error && <p className="text-lg">Loading...</p>}</div>;
  const mname = (mid: string) => merchants.find((m) => m.id === mid)?.name ?? mid;
  const chart = spend.map((s) => ({ bucket: s.bucket, spent: toUsdc(s.spent) }));

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-extrabold">{pouch.name} {pouch.frozen && <span className="ml-2 rounded-full bg-sky-800 px-3 py-1 align-middle text-sm text-white">FROZEN</span>}</h1>
      <ErrorBanner message={error} />
      <section className={card}>
        <p className="text-5xl font-extrabold">{usd(toUsdc(pouch.balance))}</p>
        <p className="mb-1 mt-3 text-base">Spent today {usd(toUsdc(pouch.spentToday))} of {usd(toUsdc(pouch.dailyLimit))}</p>
        <Progress value={pouch.spentToday} max={pouch.dailyLimit} />
        <p className="mt-2">Max per order: <b>{usd(toUsdc(pouch.maxPerOrder))}</b>
          {pouch.confirmAbove != null && <> · Ask above: <b>{usd(toUsdc(pouch.confirmAbove))}</b></>}</p>
        <p className="mt-1">Merchants: {pouch.allowedMerchantIds.map(mname).join(", ") || "none"}</p>
        <button className={`${btnSecondary} mt-4`} onClick={async () => {
          try { await (pouch.frozen ? api.unfreeze(pouch.id) : api.freeze(pouch.id)); await load(); } catch (e) { setError(errMsg(e)); }
        }}>{pouch.frozen ? "Unfreeze" : "Freeze"}</button>
      </section>

      <TopUpSection pouch={pouch} onDone={load} />

      <section className={card}>
        <h2 className="mb-3 text-2xl font-bold">Edit rules</h2>
        {saved && <Notice>Rules saved.</Notice>}
        <PouchForm key={`${pouch.maxPerOrder}-${pouch.dailyLimit}-${pouch.confirmAbove}-${pouch.allowedMerchantIds.join()}`}
          merchants={merchants} initial={pouch} withName={false} submitLabel="Save rules"
          onSubmit={async (v) => {
            try {
              const { name: _n, ...rules } = v;
              void _n;
              await api.updateRules(pouch.id, rules); setSaved(true); await load();
            } catch (e) { setError(errMsg(e)); setSaved(false); }
          }} />
      </section>

      <section className={card}>
        <h2 className="mb-3 text-2xl font-bold">Spending per day</h2>
        {chart.length === 0 ? <p className="text-lg">No spending yet.</p> : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="bucket" />
                <YAxis tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v) => usd(Number(v))} />
                <Bar dataKey="spent" fill="#1d4ed8" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className={card}>
        <h2 className="mb-3 text-2xl font-bold">Order history</h2>
        {orders.length === 0 ? <p className="text-lg">No orders yet.</p> : (
          <ul className="divide-y-2 divide-slate-200">
            {orders.map((o) => (
              <li key={o.id} className="py-3">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-bold">{o.request}</span>
                  <span className="text-lg font-extrabold">{usd(toUsdc(o.total))}</span>
                </div>
                <p className="text-base">{mname(o.merchantId)} · {new Date(o.createdAt).toLocaleString()} · <b className={o.status === "rejected" ? "text-red-800" : ""}>{o.status}</b>
                  {o.rejectReason && <> ({o.rejectReason})</>}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
