"use client";
import { useId, useState } from "react";
import type { Merchant, Pouch, CreatePouchBody } from "@solpouch/shared";
import { MAX_ALLOWED_MERCHANTS, toMicros, toUsdc, WEB_PREFIX } from "@solpouch/shared";
import { errMsg } from "@/lib/api";
import { ErrorBanner, btnPrimary, input, label } from "./ui";

export type PouchFormValues = CreatePouchBody;

/** "web:homedepot.ca" -> "homedepot.ca"; catalog ids resolved by `name`. */
export function storeLabel(id: string, name?: (id: string) => string): string {
  return id.startsWith(WEB_PREFIX)
    ? id.slice(WEB_PREFIX.length)
    : name
      ? name(id)
      : id;
}

/** [] -> "Any store", otherwise a comma list of store names. */
export function storesText(
  ids: string[],
  name?: (id: string) => string,
): string {
  return ids.length === 0
    ? "Any store"
    : ids.map((i) => storeLabel(i, name)).join(", ");
}

/** Website or domain -> bare lowercase domain, or null if it is not one. */
export function normalizeDomain(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0].replace(/^[^@]*@/, "").replace(/:\d+$/, "");
  v = v.replace(/^www\./, "").replace(/\.$/, "");
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
    v,
  )
    ? v
    : null;
}

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
  const [mode, setMode] = useState<"any" | "only">(
    !initial || initial.allowedMerchantIds.length === 0 ? "any" : "only",
  );
  const [webInput, setWebInput] = useState("");
  const [webError, setWebError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addWeb() {
    const d = normalizeDomain(webInput);
    if (!d) {
      setWebError("Enter a website like homedepot.ca.");
      return;
    }
    const web = WEB_PREFIX + d;
    if (!allowed.includes(web) && allowed.length >= MAX_ALLOWED_MERCHANTS) {
      setWebError(`A pouch can allow at most ${MAX_ALLOWED_MERCHANTS} stores. Remove one first, or choose Any store.`);
      return;
    }
    setAllowed((c) => (c.includes(web) ? c : [...c, web]));
    setWebInput("");
    setWebError(null);
  }

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
        if (mode === "only" && allowed.length === 0) {
          setError("Pick at least one store, or choose Any store.");
          return;
        }
        if (mode === "only" && allowed.length > MAX_ALLOWED_MERCHANTS) {
          setError(`A pouch can allow at most ${MAX_ALLOWED_MERCHANTS} stores. Remove some, or choose Any store.`);
          return;
        }
        setBusy(true);
        try {
          await onSubmit({
            name: name.trim(),
            maxPerOrder: toMicros(amounts[0]),
            dailyLimit: toMicros(amounts[1]),
            confirmAbove: initial?.confirmAbove ?? 0,
            allowedMerchantIds: mode === "any" ? [] : allowed,
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
            <p className="mt-2 text-xs leading-5 text-[var(--muted)]">
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
            <p className="mt-2 text-xs leading-5 text-[var(--muted)]">
              Maximum total spending per day.
            </p>
          </div>
        </div>
        <fieldset>
          <legend className={label}>Allowed stores</legend>
          <div
            role="radiogroup"
            aria-label="Store rule"
            className="mb-3 inline-flex rounded border border-[var(--line-strong)] bg-[var(--surface)] p-1"
          >
            {(
              [
                ["any", "Any store"],
                ["only", "Only stores I pick"],
              ] as const
            ).map(([val, text]) => (
              <button
                key={val}
                type="button"
                role="radio"
                aria-checked={mode === val}
                onClick={() => setMode(val)}
                className={`min-h-10 rounded px-4 text-sm font-medium transition-colors ${mode === val ? "bg-[var(--solana-purple)] text-white" : "text-[var(--muted)] hover:text-[var(--ink)]"}`}
              >
                {text}
              </button>
            ))}
          </div>
          {mode === "any" ? (
            <p className="text-sm text-[var(--muted)]">
              Solpouch can buy from any store, searching online when needed.
              Your per-order and daily limits still apply.
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {merchants.map((m) => {
                  const checked = allowed.includes(m.id);
                  return (
                    <label
                      key={m.id}
                      className={`flex min-h-12 cursor-pointer items-center gap-3 rounded border px-4 py-3 text-sm font-medium transition-colors ${checked ? "border-[var(--solana-purple)] bg-[var(--surface-raised)] text-[var(--ink)]" : "border-[var(--line-strong)] bg-[var(--surface)] text-[var(--ink)]"}`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--ok)]"
                        checked={checked}
                        disabled={!checked && allowed.length >= MAX_ALLOWED_MERCHANTS}
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
                        <span className="mt-1 block text-xs font-normal capitalize text-[var(--muted)]">
                          {m.kind.replaceAll("_", " ")}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="mt-4">
                <label className={label} htmlFor={`${id}-web`}>
                  Add a store
                </label>
                <div className="flex gap-2">
                  <input
                    id={`${id}-web`}
                    className={input}
                    value={webInput}
                    placeholder="homedepot.ca"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(e) => {
                      setWebInput(e.target.value);
                      setWebError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addWeb();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="min-h-12 shrink-0 rounded border border-[var(--line-strong)] bg-[var(--surface-raised)] px-4 text-sm font-medium text-[var(--ink)]"
                    onClick={addWeb}
                  >
                    Add
                  </button>
                </div>
                {webError && (
                  <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
                    {webError}
                  </p>
                )}
              </div>
              {allowed.some((x) => x.startsWith(WEB_PREFIX)) && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {allowed
                    .filter((x) => x.startsWith(WEB_PREFIX))
                    .map((x) => (
                      <li
                        key={x}
                        className="flex items-center gap-2 rounded border border-[var(--solana-purple)] bg-[var(--surface-raised)] py-1 pl-3 pr-1 text-sm"
                      >
                        {storeLabel(x)}
                        <button
                          type="button"
                          aria-label={`Remove ${storeLabel(x)}`}
                          className="grid h-8 w-8 place-items-center rounded text-[var(--muted)] hover:text-[var(--ink)]"
                          onClick={() =>
                            setAllowed((c) => c.filter((y) => y !== x))
                          }
                        >
                          ×
                        </button>
                      </li>
                    ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-[var(--muted)]">
                {allowed.length} of {MAX_ALLOWED_MERCHANTS} stores selected.
              </p>
              {merchants.length === 0 && (
                <p className="mt-3 rounded bg-[var(--surface-raised)] p-4 text-sm text-[var(--muted)]">
                  No built-in stores loaded. You can still add your own.
                </p>
              )}
            </>
          )}
        </fieldset>
      </fieldset>
      <div className="rounded bg-[var(--surface-raised)] px-4 py-3 text-xs leading-5 text-[var(--muted)]">
        {initial && initial.confirmAbove > 0
          ? `Orders up to ${toUsdc(initial.confirmAbove).toFixed(2)} USDC from a built-in store, with every item an exact match, are paid without asking. Everything else requires approval before payment.`
          : "Every order requires approval before payment."}
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
