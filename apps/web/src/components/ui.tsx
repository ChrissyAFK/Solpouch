"use client";
import type { ReactNode } from "react";
export const btn = "sp-button";
export const btnPrimary = `${btn} sp-button-primary`;
export const btnSecondary = `${btn} sp-button-secondary`;
export const btnDanger = `${btn} sp-button-danger`;
export const input = "sp-input";
export const label = "sp-label";
export const card = "sp-card";
export function ErrorBanner({ message }: { message: string | null }) {
  return message ? (
    <div role="alert" className="sp-error">
      {message}
    </div>
  ) : null;
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="sp-notice">
      {children}
    </div>
  );
}
export function Progress({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className="sp-progress"
      role="progressbar"
      aria-label="Daily spending limit used"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={pct >= 90 ? "progress-high" : ""}
        style={{ transform: `scaleX(${pct / 100})` }}
      />
    </div>
  );
}
export const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n,
  );
