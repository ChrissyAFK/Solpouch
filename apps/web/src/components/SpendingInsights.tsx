"use client";
import Link from "next/link";
import { useState } from "react";
import { toUsdc, type Order, type Pouch } from "@solpouch/shared";
import { spendingSummary } from "@/lib/spending";
import { usd } from "./ui";

export function SpendingInsights({pouches, orders}:{pouches:Pouch[];orders:Order[]}) {
  const [days,setDays] = useState<7|30>(7);
  const data=spendingSummary(pouches,orders,days);
  return <section className="wallet-section" aria-label="Pouch spending insights">
    <div className="section-heading flex-wrap gap-3"><h2>Pouch spending</h2><label className="flex items-center gap-2 text-sm">Period<select aria-label="Spending period" className="rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2" value={days} onChange={e=>setDays(Number(e.target.value) as 7|30)}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></label></div>
    <div className="grid gap-5 border-y border-[var(--line)] py-5 sm:grid-cols-3">
      <div><p className="text-sm text-[var(--muted)]">Recorded payments</p><p className="num mt-1 text-2xl font-semibold" data-testid="period-spend">{usd(toUsdc(data.total))} <span className="text-sm">USDC</span></p><p className="mt-1 text-sm text-[var(--muted)]">{data.count} {data.count===1?"payment":"payments"}</p></div>
      <div><p className="text-sm text-[var(--muted)]">Previous {days} days</p><p className="num mt-1 text-2xl font-semibold">{usd(toUsdc(data.previous))} <span className="text-sm">USDC</span></p><p className="mt-1 text-sm text-[var(--muted)]">Current period includes today</p></div>
      <div><p className="text-sm text-[var(--muted)]">Available within daily limits</p><p className="num mt-1 text-2xl font-semibold" data-testid="available-today">{usd(toUsdc(data.rows.reduce((sum,r)=>sum+r.available,0)))} <span className="text-sm">USDC</span></p><p className="mt-1 text-sm text-[var(--muted)]">Limited by balance and daily allowance</p></div>
    </div>
    <ul className="divide-y divide-[var(--line)]">{data.rows.map(({pouch,spent,count,todaySpent,remaining,available})=><li key={pouch.id} className="py-4" aria-label={`${pouch.name} spending`}>
      <div className="flex flex-wrap justify-between gap-2"><Link className="font-medium hover:underline" href={`/pouches/${encodeURIComponent(pouch.id)}`}>{pouch.name}{pouch.frozen?" · Frozen":""}</Link><span className="num">{usd(toUsdc(spent))} USDC · {count} {count===1?"payment":"payments"}</span></div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><div><dt className="text-[var(--muted)]">Balance</dt><dd className="num">{usd(toUsdc(pouch.balance))} USDC</dd></div><div><dt className="text-[var(--muted)]">Daily limit used</dt><dd className="num">{usd(toUsdc(todaySpent))} USDC</dd></div><div><dt className="text-[var(--muted)]">Daily allowance left</dt><dd className="num">{usd(toUsdc(remaining))} USDC</dd></div><div><dt className="text-[var(--muted)]">Available now</dt><dd className="num">{usd(toUsdc(available))} USDC</dd></div></dl>
    </li>)}</ul>
    <p className="mt-3 text-xs leading-5 text-[var(--muted)]">History uses UTC calendar days; remaining allowance uses the current pouch counter. Retailer checkout totals and unpaid estimates are excluded. Per-order limits still apply.{data.simulated>0?` Includes ${data.simulated} simulated ${data.simulated===1?"payment":"payments"}; these did not move real money.`:""}{data.undated>0?` ${data.undated} old or invalid payment dates were excluded.`:""}</p>
  </section>;
}
