"use client";
import { useEffect, useState } from "react";
import type { Order, Pouch } from "@solpouch/shared";
import { toUsdc } from "@solpouch/shared";
import { api, errMsg } from "@/lib/api";
import { ErrorBanner, Notice, btnDanger, btnPrimary, btnSecondary, card, input, label, usd } from "@/components/ui";

function ScorePill({ score }: { score: number }) {
  const cls = score >= 0.8 ? "bg-green-700 text-white" : score >= 0.5 ? "bg-amber-400 text-black" : "bg-red-700 text-white";
  return <span className={`inline-block rounded-full px-3 py-1 text-sm font-bold ${cls}`}>{Math.round(score * 100)}%</span>;
}

export default function OrderPage() {
  const [pouches, setPouches] = useState<Pouch[]>([]);
  const [request, setRequest] = useState("");
  const [pouchId, setPouchId] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.pouches().then(setPouches).catch((e) => setError(errMsg(e))); }, []);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const o = await run(() => api.createOrder({ request: request.trim(), pouchId: pouchId || undefined }));
    if (o) setOrder(o);
  }
  async function confirm() {
    if (!order) return;
    const o = await run(() => api.confirm(order.id));
    if (o) setOrder(o);
  }
  async function cancel() {
    if (!order) return;
    await run(() => api.cancel(order.id));
    setOrder(null);
  }
  const pouchName = (id: string) => pouches.find((p) => p.id === id)?.name ?? id;
  const isDraft = order?.status === "draft";

  return (
    <div>
      <h1 className="text-3xl font-extrabold">New order</h1>
      <ErrorBanner message={error} />
      {order?.status === "rejected" && (
        <ErrorBanner message={`Payment rejected: ${order.rejectReason ?? "unknown reason"}`} />
      )}
      {order?.status === "paid" && (
        <Notice>
          Paid {usd(toUsdc(order.total))} from {pouchName(order.pouchId)}.{" "}
          {order.txSignature && (order.txSignature.startsWith("mock")
            ? <span>Transaction: {order.txSignature}</span>
            : <a className="underline" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/tx/${order.txSignature}?cluster=devnet`}>View transaction</a>)}
        </Notice>
      )}

      {!order && (
        <form onSubmit={submit} className={`${card} mt-4 space-y-4`}>
          <div>
            <label className={label} htmlFor="req">What do you need?</label>
            <textarea id="req" className={`${input} text-xl`} rows={5} required value={request} onChange={(e) => setRequest(e.target.value)}
              placeholder="Two pizzas and a salad / 20 deck screws and a box of gloves" />
          </div>
          <div>
            <label className={label} htmlFor="pouch">Pay from (optional)</label>
            <select id="pouch" className={input} value={pouchId} onChange={(e) => setPouchId(e.target.value)}>
              <option value="">Let Solpouch pick</option>
              {pouches.map((p) => <option key={p.id} value={p.id}>{p.name} ({usd(toUsdc(p.balance))})</option>)}
            </select>
          </div>
          <button className={btnPrimary} disabled={busy || !request.trim()} type="submit">{busy ? "Building cart..." : "Build my cart"}</button>
        </form>
      )}

      {order && (
        <section className={`${card} mt-4`}>
          <p className="text-lg">Request: <b>{order.request}</b></p>
          <p className="mb-3">Pouch: {pouchName(order.pouchId)} · Status: <b>{order.status}</b></p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-base">
              <thead>
                <tr className="border-b-2 border-slate-800">
                  <th className="p-2">Requested</th><th className="p-2">Product</th><th className="p-2">Qty</th>
                  <th className="p-2">Unit</th><th className="p-2">Line</th><th className="p-2">Match</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((l, i) => {
                  const rowCls = !l.product ? "bg-red-100" : l.substitution ? "bg-amber-100" : "";
                  return (
                    <tr key={i} className={`border-b border-slate-300 align-top ${rowCls}`}>
                      <td className="p-2">{l.requested} <span className="text-slate-600">x{l.requestedQty}</span></td>
                      <td className="p-2">
                        {l.product ? (
                          <>
                            <b>{l.product.name}</b>
                            <div className="text-sm">{[l.product.brand, l.product.size].filter(Boolean).join(" · ")}</div>
                          </>
                        ) : <b className="text-red-800">Not available</b>}
                        {l.substitution && <div className="font-bold text-amber-900">Substitution{l.note ? `: ${l.note}` : ""}</div>}
                        {!l.substitution && l.note && <div className="text-sm">{l.note}</div>}
                      </td>
                      <td className="p-2">{l.qty}</td>
                      <td className="p-2">{l.product ? usd(toUsdc(l.product.unitPrice)) : "-"}</td>
                      <td className="p-2">{l.product ? usd(toUsdc(l.lineTotal)) : "-"}</td>
                      <td className="p-2"><ScorePill score={l.matchScore} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-3xl font-extrabold">Total: {usd(toUsdc(order.total))}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {isDraft && <button className={btnPrimary} disabled={busy} onClick={confirm}>{busy ? "Paying..." : "Confirm and pay"}</button>}
            {isDraft && <button className={btnDanger} disabled={busy} onClick={cancel}>Cancel</button>}
            {!isDraft && <button className={btnSecondary} onClick={() => setOrder(null)}>Start another order</button>}
          </div>
        </section>
      )}
    </div>
  );
}
