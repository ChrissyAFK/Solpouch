"use client";
import Link from "next/link";
import { useState } from "react";
import { toUsdc, type Order, type Pouch } from "@solpouch/shared";
import { spendingSummary } from "@/lib/spending";
import { usd } from "./ui";

const money = (micros: number) => usd(toUsdc(micros));

function versusPrevious(total: number, previous: number, days: number) {
  if (total === 0 && previous === 0) return `Nothing spent in the last ${days * 2} days`;
  if (total === previous) return `Same as the ${days} days before`;
  const diff = total - previous;
  return `${diff > 0 ? "+" : "−"}${money(Math.abs(diff))} vs the ${days} days before`;
}

export function SpendingInsights({pouches, orders}:{pouches:Pouch[];orders:Order[]}) {
  const [days,setDays] = useState<7|30>(7);
  const data=spendingSummary(pouches,orders,days);
  const availableToday = data.rows.reduce((sum,r)=>sum+r.available,0);
  return <section className="wallet-section sp-card sp-insights" aria-label="Pouch spending insights">
    <div className="section-heading flex-wrap gap-3">
      <h2>Pouch spending</h2>
      <label className="flex items-center gap-2 text-sm text-[var(--muted)]"><span className="sr-only">Period</span><select aria-label="Spending period" className="rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[var(--ink)]" value={days} onChange={e=>setDays(Number(e.target.value) as 7|30)}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></label>
    </div>

    <div className="si-summary">
      <div>
        <p className="stat-label">Spent</p>
        <p className="si-figure" data-testid="period-spend">{money(data.total)}</p>
        <p className="stat-sub">{data.count} {data.count===1?"payment":"payments"} · {versusPrevious(data.total, data.previous, days)}</p>
      </div>
      <div>
        <p className="stat-label">You can still spend today</p>
        <p className="si-figure si-figure-accent" data-testid="available-today">{money(availableToday)}</p>
        <p className="stat-sub">Across {data.rows.length} {data.rows.length===1?"pouch":"pouches"}, within balance and daily limits</p>
      </div>
    </div>

    <ul className="si-rows">{data.rows.map(({pouch,spent,count,todaySpent,available})=>{
      const used = pouch.dailyLimit > 0 ? Math.min(1, todaySpent / pouch.dailyLimit) : 0;
      const level = used >= 0.9 ? "si-bar-high" : used >= 0.6 ? "si-bar-mid" : "";
      return <li key={pouch.id} aria-label={`${pouch.name} spending`} className={pouch.frozen ? "si-frozen" : undefined}>
        <div className="si-name">
          <Link href={`/pouches/${encodeURIComponent(pouch.id)}`}>{pouch.name}</Link>
          {pouch.frozen && <span className="si-badge">Frozen</span>}
          <span className="si-meta">{money(pouch.balance)} balance · {count>0 ? `${money(spent)} spent, ${count} ${count===1?"payment":"payments"}` : "no payments"}</span>
        </div>
        <div className="si-today">
          <div className="si-bar" role="meter" aria-label={`${pouch.name} daily limit used`} aria-valuemin={0} aria-valuemax={toUsdc(pouch.dailyLimit)} aria-valuenow={toUsdc(todaySpent)}><div className={level} style={{transform:`scaleX(${used})`}} /></div>
          <span className="si-meta">{money(todaySpent)} of {money(pouch.dailyLimit)} used today</span>
        </div>
        <div className="si-available">
          <span className="num">{money(available)}</span>
          <span className="si-meta">{pouch.frozen ? "frozen" : "left today"}</span>
        </div>
      </li>;
    })}</ul>

    <details className="si-notes">
      <summary>How these numbers work</summary>
      <p>Amounts are in USDC. History uses UTC calendar days, and today&apos;s limit follows each pouch&apos;s own counter. Retailer checkout totals and unpaid estimates are left out, and per-order limits still apply.{data.simulated>0?` Includes ${data.simulated} simulated ${data.simulated===1?"payment":"payments"} that did not move real money.`:""}{data.undated>0?` ${data.undated} ${data.undated===1?"payment with an old or invalid date was":"payments with old or invalid dates were"} left out.`:""}</p>
    </details>
  </section>;
}
