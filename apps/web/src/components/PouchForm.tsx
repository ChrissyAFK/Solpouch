"use client";
import { useId, useState } from "react";
import type { Merchant, Pouch, CreatePouchBody } from "@solpouch/shared";
import { toMicros, toUsdc } from "@solpouch/shared";
import { errMsg } from "@/lib/api";
import { ErrorBanner, btnPrimary, input, label } from "./ui";

export type PouchFormValues = CreatePouchBody;

export function PouchForm({
  merchants,
  initial,
  withName,
  submitLabel,
  onSubmit,
}: {
  merchants: Merchant[];
  initial?: Pouch;
  withName: boolean;
  submitLabel: string;
  onSubmit: (v: PouchFormValues) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [maxPerOrder, setMax] = useState(
    initial ? String(toUsdc(initial.maxPerOrder)) : "",
  );
  const [dailyLimit, setDaily] = useState(
    initial ? String(toUsdc(initial.dailyLimit)) : "",
  );
  const [allowed, setAllowed] = useState<string[]>(
    initial?.allowedMerchantIds ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setError(null);
        const amounts = [maxPerOrder, dailyLimit].map(Number);
        if (
          amounts.some(
            (v) =>
              !Number.isFinite(v) ||
              v < 0 ||
              !Number.isSafeInteger(toMicros(v)),
          )
        ) {
          setError("Enter valid, non-negative spending limits.");
          return;
        }
        if (withName && !name.trim()) {
          setError("Give your pouch a name.");
          return;
        }
        setBusy(true);
        try {
          await onSubmit({
            name: name.trim(),
            maxPerOrder: toMicros(amounts[0]),
            dailyLimit: toMicros(amounts[1]),
            confirmAbove: initial?.confirmAbove ?? 0,
            allowedMerchantIds: allowed,
          });
        } catch (err) {
          setError(errMsg(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBanner message={error} />
      <fieldset disabled={busy} className="space-y-6 disabled:opacity-70">
        {withName && (
          <div>
            <label className={label} htmlFor={`${id}-name`}>
              Pouch name
            </label>
            <input
              id={`${id}-name`}
              className={input}
              required
              maxLength={32}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly groceries"
            />
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor={`${id}-max`}>
              Per-order limit · USDC
            </label>
            <input
              id={`${id}-max`}
              className={input}
              required
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder="25.00"
              value={maxPerOrder}
              onChange={(e) => setMax(e.target.value)}
            />
            <p className="mt-2 text-xs leading-5 text-[#a9a5b9]">
              The most a single order can cost.
            </p>
          </div>
          <div>
            <label className={label} htmlFor={`${id}-daily`}>
              Daily limit · USDC
            </label>
            <input
              id={`${id}-daily`}
              className={input}
              required
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder="50.00"
              value={dailyLimit}
              onChange={(e) => setDaily(e.target.value)}
            />
            <p className="mt-2 text-xs leading-5 text-[#a9a5b9]">
              Maximum total spending per day.
            </p>
          </div>
        </div>
        <fieldset>
          <legend className={label}>Allowed stores</legend>
          <p className="mb-3 text-sm text-[#a9a5b9]">
            Choose where this pouch can be used.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {merchants.map((m) => {
              const checked = allowed.includes(m.id);
              return (
                <label
                  key={m.id}
                  className={`flex min-h-12 cursor-pointer items-center gap-3 rounded border px-4 py-3 text-sm font-medium transition-colors ${checked ? "border-[#9945ff] bg-[#201b2b] text-[#f1edf8]" : "border-[#373041] bg-[#14121b] text-[#f1edf8]"}`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#14f195]"
                    checked={checked}
                    onChange={() =>
                      setAllowed((current) =>
                        checked
                          ? current.filter((x) => x !== m.id)
                          : [...current, m.id],
                      )
                    }
                  />
                  <span>
                    {m.name}
                    <span className="mt-1 block text-xs font-normal capitalize text-[#a9a5b9]">
                      {m.kind.replaceAll("_", " ")}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {merchants.length === 0 && (
            <p className="rounded bg-[#211d2d] p-4 text-sm text-[#a9a5b9]">
              No stores are available. Reload the page to try again.
            </p>
          )}
          {merchants.length > 0 && allowed.length === 0 && (
            <p className="mt-3 text-xs text-[#f4c879]">
              No stores selected. This pouch will not be able to make purchases.
            </p>
          )}
        </fieldset>
      </fieldset>
      <div className="rounded bg-[#211d2d] px-4 py-3 text-xs leading-5 text-[#a9a5b9]">
        Every order requires approval before payment.
      </div>
      <button
        className={`${btnPrimary} w-full sm:w-auto`}
        disabled={busy}
        type="submit"
      >
        {busy ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
