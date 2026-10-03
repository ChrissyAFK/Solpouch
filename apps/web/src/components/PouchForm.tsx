"use client";
import { useState } from "react";
import type { Merchant, Pouch, CreatePouchBody } from "@solpouch/shared";
import { toMicros, toUsdc } from "@solpouch/shared";
import { btnPrimary, input, label } from "./ui";

export type PouchFormValues = CreatePouchBody;

export function PouchForm({
  merchants, initial, withName, submitLabel, onSubmit,
}: {
  merchants: Merchant[];
  initial?: Pouch;
  withName: boolean;
  submitLabel: string;
  onSubmit: (v: PouchFormValues) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [maxPerOrder, setMax] = useState(initial ? String(toUsdc(initial.maxPerOrder)) : "");
  const [dailyLimit, setDaily] = useState(initial ? String(toUsdc(initial.dailyLimit)) : "");
  const [confirmAbove, setConfirm] = useState(
    initial && initial.confirmAbove != null ? String(toUsdc(initial.confirmAbove)) : "",
  );
  const [allowed, setAllowed] = useState<string[]>(initial?.allowedMerchantIds ?? []);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit({
            name: name.trim(),
            maxPerOrder: toMicros(Number(maxPerOrder)),
            dailyLimit: toMicros(Number(dailyLimit)),
            confirmAbove: confirmAbove.trim() === "" ? undefined : toMicros(Number(confirmAbove)),
            allowedMerchantIds: allowed,
          });
        } finally { setBusy(false); }
      }}
    >
      {withName && (
        <div>
          <label className={label} htmlFor="pf-name">Pouch name</label>
          <input id="pf-name" className={input} required value={name} onChange={(e) => setName(e.target.value)} placeholder="Groceries" />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="pf-max">Max per order ($)</label>
          <input id="pf-max" className={input} required type="number" min="0" step="0.01" inputMode="decimal" value={maxPerOrder} onChange={(e) => setMax(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="pf-daily">Daily limit ($)</label>
          <input id="pf-daily" className={input} required type="number" min="0" step="0.01" inputMode="decimal" value={dailyLimit} onChange={(e) => setDaily(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="pf-conf">Ask me above ($, optional)</label>
          <input id="pf-conf" className={input} type="number" min="0" step="0.01" inputMode="decimal" value={confirmAbove} onChange={(e) => setConfirm(e.target.value)} />
        </div>
      </div>
      <fieldset>
        <legend className={label}>Allowed merchants</legend>
        <div className="flex flex-wrap gap-3">
          {merchants.map((m) => {
            const on = allowed.includes(m.id);
            return (
              <label key={m.id} className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border-2 px-4 py-2 font-bold ${on ? "border-blue-700 bg-blue-100" : "border-slate-400 bg-white"}`}>
                <input type="checkbox" className="h-5 w-5" checked={on}
                  onChange={() => setAllowed(on ? allowed.filter((x) => x !== m.id) : [...allowed, m.id])} />
                {m.name}
              </label>
            );
          })}
          {merchants.length === 0 && <p>No merchants loaded.</p>}
        </div>
      </fieldset>
      <button className={btnPrimary} disabled={busy} type="submit">{busy ? "Saving..." : submitLabel}</button>
    </form>
  );
}
