"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Merchant, Pouch } from "@solpouch/shared";
import { toUsdc } from "@solpouch/shared";
import { api, errMsg } from "@/lib/api";
import { PouchForm } from "@/components/PouchForm";
import { ErrorBanner, Progress, btnSecondary, card, usd } from "@/components/ui";

export default function PouchesPage() {
  const [pouches, setPouches] = useState<Pouch[] | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([api.pouches(), api.merchants()]);
      setPouches(p); setMerchants(m); setError(null);
    } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(p: Pouch) {
    try {
      await (p.frozen ? api.unfreeze(p.id) : api.freeze(p.id));
      await load();
    } catch (e) { setError(errMsg(e)); }
  }

  return (
    <div>
      <h1 className="text-3xl font-extrabold">Your pouches</h1>
      <p className="mt-1 text-lg">Budget pouches your AI shops from, and can&apos;t refill.</p>
      <ErrorBanner message={error} />
      {!pouches && !error && <p className="mt-4 text-lg">Loading...</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {pouches?.map((p) => (
          <div key={p.id} className={card}>
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-xl font-bold"><Link href={`/pouches/${p.id}`} className="underline">{p.name}</Link></h2>
              {p.frozen && <span className="rounded-full bg-sky-800 px-3 py-1 text-sm font-bold text-white">FROZEN</span>}
            </div>
            <p className="my-2 text-4xl font-extrabold">{usd(toUsdc(p.balance))}</p>
            <p className="mb-1 text-base">Spent today {usd(toUsdc(p.spentToday))} of {usd(toUsdc(p.dailyLimit))}</p>
            <Progress value={p.spentToday} max={p.dailyLimit} />
            <p className="mt-2 text-base">Max per order: <b>{usd(toUsdc(p.maxPerOrder))}</b></p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={`/pouches/${p.id}`} className={btnSecondary}>Open</Link>
              <button className={btnSecondary} onClick={() => toggle(p)}>{p.frozen ? "Unfreeze" : "Freeze"}</button>
            </div>
          </div>
        ))}
      </div>
      {pouches?.length === 0 && <p className="mt-4 text-lg">No pouches yet.</p>}

      <section className={`${card} mt-8`}>
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">New pouch</h2>
          <button className={btnSecondary} onClick={() => setShowForm(!showForm)} aria-expanded={showForm}>{showForm ? "Hide" : "Create"}</button>
        </div>
        {showForm && (
          <div className="mt-4">
            <PouchForm merchants={merchants} withName submitLabel="Create pouch"
              onSubmit={async (v) => {
                try { await api.createPouch(v); setShowForm(false); await load(); setError(null); }
                catch (e) { setError(errMsg(e)); }
              }} />
          </div>
        )}
      </section>
    </div>
  );
}
