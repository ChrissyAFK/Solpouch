"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { StatePanel } from "@/components/StatePanel";
import { PouchSkeleton } from "@/components/Skeletons";
import { useParams } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  Merchant,
  Order,
  Pouch,
  SpendPoint,
  TopUp,
} from "@solpouch/shared";
import { toMicros, toUsdc } from "@solpouch/shared";
import { api, ApiRequestError, errMsg } from "@/lib/api";
import { useLiveRefresh } from "@/lib/useLiveRefresh";
import { PouchForm } from "@/components/PouchForm";
import { PouchGlyph } from "@/components/PouchGlyph";
import {
  ErrorBanner,
  Notice,
  Progress,
  btnPrimary,
  btnSecondary,
  card,
  input,
  label,
  usd,
} from "@/components/ui";

function TopUpSection({
  pouch,
  onDone,
}: {
  pouch: Pouch;
  onDone: () => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [topup, setTopup] = useState<TopUp | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!topup) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [topup]);

  const remaining = topup
    ? Math.max(0, new Date(topup.readyAt).getTime() - now)
    : 0;
  const ready = topup != null && remaining === 0;
  const seconds = Math.ceil(remaining / 1000);
  const countdown = `${Math.floor(seconds / 3600) > 0 ? `${Math.floor(seconds / 3600)}h ` : ""}${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const micros = toMicros(Number(amount));
    if (
      !Number.isSafeInteger(micros) ||
      micros <= 0 ||
      reason.trim().length < 10
    ) {
      setError("Enter a valid amount and a reason of at least 10 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      setTopup(
        await api.startTopUp({
          pouchId: pouch.id,
          amount: micros,
          reason: reason.trim(),
        }),
      );
      setNow(Date.now());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  async function complete() {
    if (!topup || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.completeTopUp(topup.id);
      setTopup(null);
      setAmount("");
      setReason("");
      setDone(true);
      await onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <div className="mb-5 flex items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Add funds</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Top-ups require a waiting period.
          </p>
        </div>
      </div>
      <ErrorBanner message={error} />
      {done && <Notice>Top-up complete. Your balance has been updated.</Notice>}
      {!topup ? (
        <form onSubmit={start} className="space-y-4">
          <div>
            <label className={label} htmlFor="tu-amt">
              Amount · USDC
            </label>
            <input
              id="tu-amt"
              className={input}
              disabled={busy}
              required
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <label className={label} htmlFor="tu-reason">
              What is this refill for?
            </label>
            <textarea
              id="tu-reason"
              className={input}
              disabled={busy}
              required
              minLength={10}
              rows={3}
              placeholder="e.g. A few extra groceries for the weekend"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="mt-2 text-xs text-[var(--muted)]">
              At least 10 characters. A waiting period applies before you can
              complete the top-up.
            </p>
          </div>
          <button
            className={`${btnPrimary} w-full`}
            disabled={
              busy || reason.trim().length < 10 || !(Number(amount) > 0)
            }
            type="submit"
          >
            {busy ? "Starting top-up…" : "Start top-up"}
          </button>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="rounded bg-[var(--surface-raised)] p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
              {ready ? "Ready to add" : "Cooling down"}
            </p>
            <p className="mt-2 text-3xl font-semibold tracking-tight">
              {usd(toUsdc(topup.amount))}
            </p>
            <p className="mt-2 text-sm text-[var(--muted)]">{topup.reason}</p>
          </div>
          <p className="text-sm font-medium" role="status">
            {ready
              ? "Your waiting period is over."
              : `Time remaining: ${countdown}`}
          </p>
          <button
            className={`${btnPrimary} w-full`}
            disabled={!ready || busy}
            onClick={complete}
          >
            {busy ? "Completing…" : "Complete top-up"}
          </button>
          <p className="text-xs leading-5 text-[var(--muted)]">
            Keep this page open to complete this top-up. Pending top-ups cannot
            currently be recovered from the dashboard after a reload.
          </p>
        </div>
      )}
    </section>
  );
}

export default function PouchDetail() {
  const { id } = useParams<{ id: string }>();
  const [pouch, setPouch] = useState<Pouch | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [spend, setSpend] = useState<SpendPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [freezing, setFreezing] = useState(false);
  const loadVersion = useRef(0);

  // quiet: background refresh, keeps what is on screen and skips loading and error states.
  const load = useCallback(async (quiet = false) => {
    // A quiet refresh never supersedes a full load, so it cannot strand the loading state.
    const version = quiet ? loadVersion.current : ++loadVersion.current;
    if (!quiet) {
      setLoading(true);
      setError(null);
      setMissing(false);
    }
    try {
      let p: Pouch;
      try {
        p = await api.pouch(id);
      } catch (e) {
        if (
          version === loadVersion.current &&
          e instanceof ApiRequestError &&
          e.status === 404
        )
          setMissing(true);
        throw e;
      }
      const [m, o, s] = await Promise.all([
        api.merchants(),
        api.orders(id),
        api.spend(id, "day"),
      ]);
      if (version !== loadVersion.current) return;
      setPouch(p);
      setMerchants(m);
      setOrders(o);
      setSpend(s);
      setError(null);
    } catch (e) {
      if (version === loadVersion.current && !quiet) setError(errMsg(e));
    } finally {
      if (version === loadVersion.current && !quiet) setLoading(false);
    }
  }, [id]);
  useLiveRefresh(useCallback(() => load(true), [load]));
  useEffect(() => {
    setPouch(null);
    setSaved(false);
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [load]);

  if ((!pouch || pouch.id !== id) && (!error || loading))
    return <PouchSkeleton />;

  if (missing || !pouch || pouch.id !== id)
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-semibold">Pouch details</h1>
        <StatePanel
          title={missing ? "Pouch not found" : "Pouch couldn’t be loaded"}
          retry={missing ? undefined : () => void load()}
          home
        >
          {missing
            ? "This pouch is no longer available. Return to the overview to choose another pouch."
            : "We couldn’t load this pouch and its activity. Check the connection and try again."}
        </StatePanel>
      </div>
    );
  const mname = (mid: string) =>
    merchants.find((m) => m.id === mid)?.name ?? mid;
  const chart = spend.map((s) => ({
    bucket: new Date(s.bucket).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }),
    spent: toUsdc(s.spent),
  }));
  const available = Math.max(0, pouch.dailyLimit - pouch.spentToday);

  return (
    <div className="space-y-7">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)]"
      >
        ← All pouches
      </Link>
      <header className="flex flex-wrap items-center gap-6">
        <PouchGlyph
          name={pouch.name}
          remaining={toUsdc(available)}
          limit={toUsdc(pouch.dailyLimit)}
          size="lg"
          frozen={pouch.frozen}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {pouch.name}
            </h1>
            <span
              className={`rounded px-3 py-1 text-sm font-medium ${pouch.frozen ? "bg-[var(--danger-surface)] text-[var(--danger)]" : "bg-[var(--ok-surface)] text-[var(--ok)]"}`}
            >
              {pouch.frozen ? "Frozen" : "Active"}
            </span>
          </div>
          <p className="num mt-3 text-3xl font-semibold">
            {usd(toUsdc(pouch.balance))}{" "}
            <span className="text-sm font-normal text-[var(--muted)]">
              USDC balance
            </span>
          </p>
          <p className="num mt-1 text-sm text-[var(--muted)]">
            <span className="text-[var(--ink)]">{usd(toUsdc(available))}</span>{" "}
            left today of {usd(toUsdc(pouch.dailyLimit))} daily limit
          </p>
          <div className="mt-3 max-w-md">
            <Progress value={pouch.spentToday} max={pouch.dailyLimit} />
          </div>
          <dl className="num mt-4 grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-[var(--muted)]">Per order</dt>
            <dd>{usd(toUsdc(pouch.maxPerOrder))}</dd>
            <dt className="text-[var(--muted)]">Daily</dt>
            <dd>{usd(toUsdc(pouch.dailyLimit))}</dd>
            <dt className="text-[var(--muted)]">Stores</dt>
            <dd className="font-sans">
              {pouch.allowedMerchantIds.length > 0
                ? pouch.allowedMerchantIds.map(mname).join(", ")
                : "None"}
            </dd>
          </dl>
        </div>
      </header>
      <ErrorBanner message={error} />
      {error && (
        <button
          className={btnSecondary}
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "Refreshing…" : "Retry refresh"}
        </button>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
        <div className="min-w-0 space-y-6">
          <section className={card}>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold tracking-tight">
                Spending activity
              </h2>
              <span className="rounded bg-[var(--surface-raised)] px-3 py-1 text-xs text-[var(--muted)]">
                Daily (UTC) · USDC
              </span>
            </div>
            {chart.length === 0 ? (
              <div className="py-8 text-sm text-[var(--muted)]">
                <p className="font-medium">No spending yet.</p>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Completed payments will appear here.
                </p>
              </div>
            ) : (
              <div
                className="h-60 w-full"
                role="img"
                aria-label="Daily pouch spending bar chart"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chart}
                    margin={{ top: 5, right: 8, left: -15, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="4 4"
                      vertical={false}
                      stroke="var(--line-strong)"
                    />
                    <XAxis
                      dataKey="bucket"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "var(--muted)", fontSize: 12 }}
                      dy={8}
                    />
                    <YAxis
                      tickFormatter={(v) => `$${v}`}
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "var(--muted)", fontSize: 12 }}
                    />
                    <Tooltip
                      formatter={(v) => usd(Number(v))}
                      contentStyle={{
                        borderRadius: 4,
                        background: "var(--surface)",
                        color: "var(--ink)",
                        border: "1px solid var(--line-strong)",
                        fontSize: 14,
                      }}
                      cursor={{ fill: "var(--surface-raised)" }}
                    />
                    <Bar
                      name="Spent"
                      dataKey="spent"
                      fill="var(--ok)"
                      radius={[6, 6, 0, 0]}
                      maxBarSize={42}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>
          <section className={card}>
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold tracking-tight">
                Order history
              </h2>
              <span className="text-xs text-[var(--muted)]">
                {orders.length} {orders.length === 1 ? "order" : "orders"}
              </span>
            </div>
            {orders.length === 0 ? (
              <div className="py-7 text-center">
                <p className="font-medium">No orders yet.</p>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Orders and their status will appear here.
                </p>
                <Link
                  href={`/order?pouch=${encodeURIComponent(pouch.id)}`}
                  className={`${btnSecondary} mt-5`}
                >
                  Start an order →
                </Link>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--line-strong)]">
                {orders.map((o) => (
                  <li key={o.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <Link
                          href={`/order?order=${encodeURIComponent(o.id)}`}
                          className="break-words text-sm font-medium text-[var(--ok)] underline decoration-[var(--line-strong)] underline-offset-4 hover:decoration-[var(--ok)]"
                        >
                          {o.request}
                        </Link>
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          {mname(o.merchantId)} ·{" "}
                          {new Date(o.createdAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-semibold">
                        {usd(toUsdc(o.total))}
                      </p>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${o.status === "rejected" ? "bg-[var(--danger-surface)] text-[var(--danger)]" : o.status === "paid" ? "bg-[var(--ok-surface)] text-[var(--ok)]" : "bg-[var(--surface-raised)] text-[var(--muted)]"}`}
                      >
                        {o.status === "draft" ? "Awaiting approval" : o.status}
                      </span>
                      {o.rejectReason && (
                        <span className="text-xs text-[var(--danger)]">
                          {o.rejectReason}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <div className="min-w-0 space-y-6">
          <section className={card}>
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold tracking-tight">
                Spending limits
              </h2>
            </div>
            <p className="mb-5 text-sm leading-6 text-[var(--muted)]">
              Limits apply to every payment from this pouch.
            </p>
            {saved && <Notice>Spending rules saved.</Notice>}
            <PouchForm
              key={`${pouch.id}-${pouch.maxPerOrder}-${pouch.dailyLimit}-${pouch.confirmAbove}-${pouch.allowedMerchantIds.join()}`}
              merchants={merchants}
              initial={pouch}
              withName={false}
              submitLabel="Save changes"
              onSubmit={async (v) => {
                setSaved(false);
                const { name: _name, ...rules } = v;
                void _name;
                const updated = await api.updateRules(pouch.id, rules);
                setPouch(updated);
                setSaved(true);
              }}
            />
            <div className="mt-6 border-t border-[var(--line-strong)] pt-5">
              <div className="mb-4">
                <h3 className="text-sm font-medium">
                  {pouch.frozen ? "Resume payments" : "Pause payments"}
                </h3>
                <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                  {pouch.frozen
                    ? "Unfreeze this pouch to allow new payments."
                    : "Freeze this pouch to pause payments. You can unfreeze it anytime."}
                </p>
              </div>
              <button
                className={`${btnSecondary} w-full`}
                disabled={freezing}
                onClick={async () => {
                  if (freezing) return;
                  setFreezing(true);
                  setError(null);
                  try {
                    const updated = await (pouch.frozen
                      ? api.unfreeze(pouch.id)
                      : api.freeze(pouch.id));
                    setPouch(updated);
                  } catch (e) {
                    setError(errMsg(e));
                  } finally {
                    setFreezing(false);
                  }
                }}
              >
                {freezing
                  ? "Updating…"
                  : pouch.frozen
                    ? "Unfreeze pouch"
                    : "Freeze pouch"}
              </button>
            </div>
          </section>
          <TopUpSection key={pouch.id} pouch={pouch} onDone={load} />
        </div>
      </div>
    </div>
  );
}
