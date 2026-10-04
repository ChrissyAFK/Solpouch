"use client";
import Link from "next/link";
import { useState } from "react";
import { toUsdc, type Order, type Pouch } from "@solpouch/shared";
import { spendingSummary } from "@/lib/spending";
import { usd } from "./ui";

export function SpendingInsights({pouches, orders}:{pouches:Pouch[];orders:Order[]}) {
  const [days,setDays] = useState<7|30>(7);
  const data=spendingSummary(pouches,orders,days);
  return <section className="wallet-section sp-card sp-insights" aria-label="Pouch spending insights">
    <div className="section-heading flex-wrap gap-3"><h2>Pouch spending</h2><label className="flex items-center gap-2 text-sm">Period<select aria-label="Spending period" className="rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2" value={days} onChange={e=>setDays(Number(e.target.value) as 7|30)}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></label></div>
    <div className="stat-grid-sm">
      <div><p className="stat-label">Recorded payments</p><p className="stat-figure" data-testid="period-spend">{usd(toUsdc(data.total))} <small>USDC</small></p><p className="stat-sub">{data.count} {data.count===1?"payment":"payments"}</p></div>
      <div><p className="stat-label">Previous {days} days</p><p className="stat-figure">{usd(toUsdc(data.previous))} <small>USDC</small></p><p className="stat-sub">Current period includes today</p></div>
      <div><p className="stat-label">Available within daily limits</p><p className="stat-figure" data-testid="available-today">{usd(toUsdc(data.rows.reduce((sum,r)=>sum+r.available,0)))} <small>USDC</small></p><p className="stat-sub">Limited by balance and daily allowance</p></div>
    </div>
    <ul className="sp-insights-rows">{data.rows.map(({pouch,spent,count,todaySpent,remaining,available})=><li key={pouch.id} aria-label={`${pouch.name} spending`}>
      <div className="sp-row-head"><Link className="font-medium hover:underline" href={`/pouches/${encodeURIComponent(pouch.id)}`}>{pouch.name}{pouch.frozen?" · Frozen":""}</Link><span className="num">{usd(toUsdc(spent))} USDC · {count} {count===1?"payment":"payments"}</span></div>
      <dl className="sp-row-pairs"><div><dt>Balance</dt><dd className="num">{usd(toUsdc(pouch.balance))} USDC</dd></div><div><dt>Daily limit used</dt><dd className="num">{usd(toUsdc(todaySpent))} USDC</dd></div><div><dt>Daily allowance left</dt><dd className="num">{usd(toUsdc(remaining))} USDC</dd></div><div><dt>Available now</dt><dd className="num">{usd(toUsdc(available))} USDC</dd></div></dl>
    </li>)}</ul>
    <p className="sp-footnote">History uses UTC calendar days; remaining allowance uses the current pouch counter. Retailer checkout totals and unpaid estimates are excluded. Per-order limits still apply.{data.simulated>0?` Includes ${data.simulated} simulated ${data.simulated===1?"payment":"payments"}; these did not move real money.`:""}{data.undated>0?` ${data.undated} old or invalid payment dates were excluded.`:""}</p>
  </section>;
}
