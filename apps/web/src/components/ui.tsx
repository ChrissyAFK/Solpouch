"use client";
import type { ReactNode } from "react";

export const btn =
  "inline-flex min-h-12 items-center justify-center rounded-lg px-5 py-2 text-base font-bold focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50";
export const btnPrimary = `${btn} bg-blue-700 text-white hover:bg-blue-800`;
export const btnSecondary = `${btn} border-2 border-slate-800 bg-white text-slate-900 hover:bg-slate-100`;
export const btnDanger = `${btn} bg-red-700 text-white hover:bg-red-800`;
export const input =
  "block w-full min-h-12 rounded-lg border-2 border-slate-600 bg-white px-3 py-2 text-base focus:outline-none focus:ring-4 focus:ring-blue-400";
export const label = "mb-1 block text-base font-bold";
export const card = "rounded-xl border-2 border-slate-300 bg-white p-5 shadow-sm";

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="my-4 rounded-lg border-2 border-red-800 bg-red-100 p-4 text-base font-bold text-red-900">
      {message}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="my-4 rounded-lg border-2 border-green-800 bg-green-100 p-4 text-base font-bold text-green-900">{children}</div>;
}

export function Progress({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = pct >= 90 ? "bg-red-700" : pct >= 60 ? "bg-amber-500" : "bg-green-700";
  return (
    <div className="h-4 w-full overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
