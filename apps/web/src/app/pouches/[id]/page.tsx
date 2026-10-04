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

const CHIPS = [10, 25, 50, 100];
const MAX_TOPUP = 10000;
const STEPS = ["Choose amount", "Short safety wait (60 s)", "Added to pouch"];

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
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoFailed, setAutoFailed] = useState(false);
  const completing = useRef(false);

  // Resume the newest pending top-up so a reload does not lose it.
  useEffect(() => {
    let live = true;
    api
      .listPendingTopUps(pouch.id)
      .then((list) => {
        if (live && list.length > 0) {
          setTopup((cur) => cur ?? list[0]);
          setNow(Date.now());
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pouch.id]);

  useEffect(() => {
    if (!topup) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [topup]);

  const readyAt = topup ? new Date(topup.readyAt).getTime() : 0;
  const remaining = topup ? Math.max(0, readyAt - now) : 0;
  const ready = topup != null && remaining === 0;
  const seconds = Math.ceil(remaining / 1000);
  const total = topup
    ? Math.max(1000, readyAt - new Date(topup.createdAt).getTime())
    : 60000;
  const pct = topup ? Math.min(100, ((total - remaining) / total) * 100) : 0;
  const step = added ? 3 : topup ? 2 : 1;

  const complete = useCallback(
    async (auto: boolean) => {
      if (!topup || completing.current) return;
      completing.current = true;
      setBusy(true);
      setError(null);
      try {
        await api.completeTopUp(topup.id);
        setAdded(`Added ${usd(toUsdc(topup.amount))} USDC to ${pouch.name}`);
        setTopup(null);
        setAmount("");
        setReason("");
        setAutoFailed(false);
        await onDone();
      } catch (err) {
        setAutoFailed(true);
        setError(
          auto ? `Could not add automatically. ${errMsg(err)}` : errMsg(err),
        );
      } finally {
        completing.current = false;
        setBusy(false);
      }
    },
    [topup, pouch.name, onDone],
  );

  useEffect(() => {
    if (ready && !autoFailed && !completing.current) void complete(true);
  }, [ready, autoFailed, complete]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const micros = toMicros(Number(amount));
    if (!Number.isSafeInteger(micros) || micros <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    if (Number(amount) > MAX_TOPUP) {
      setError(
        `The most you can add at once is ${MAX_TOPUP.toLocaleString()} USDC.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    setAdded(null);
    setAutoFailed(false);
    try {
      const note = reason.trim();
      setTopup(
        await api.startTopUp({
          pouchId: pouch.id,
          amount: micros,
          ...(note ? { reason: note } : {}),
        }),
      );
      setNow(Date.now());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!topup || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelTopUp(topup.id);
      setTopup(null);
      setAutoFailed(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="add-funds" className="scroll-mt-6 space-y-3">
      {pouch.balance === 0 && !topup && !added && (
        <p className="rounded bg-[#211d2d] px-4 py-3 text-sm text-[#d9d1e6]">
          This pouch is empty. Add funds to start spending.
        </p>
      )}
      <section className={card}>
        <div className="mb-4">
          <h2 className="text-lg font-semibold tracking-tight">Add funds</h2>
          <p className="mt-1 text-xs text-[#a9a5b9]">
            A short wait on every top-up stops rushed or unauthorised refills.
          </p>
        </div>
        <ol className="mb-5 grid grid-cols-3 gap-2" aria-label="Top-up steps">
          {STEPS.map((s, i) => {
            const n = i + 1;
            const on = n <= step;
            return (
              <li
                key={s}
                aria-current={n === step ? "step" : undefined}
                className={`flex flex-col gap-1 border-t-2 pt-2 text-[11px] leading-4 sm:text-xs ${on ? "border-[#14f195] text-white" : "border-[#373041] text-[#a9a5b9]"}`}
              >
                <span className="font-semibold">{n}</span>
                <span>{s}</span>
              </li>
            );
          })}
        </ol>
        <ErrorBanner message={error} />
        {added && <Notice>{added}</Notice>}
        {!topup ? (
          <form onSubmit={start} className="space-y-4">
            <div>
              <span className={label}>Amount · USDC</span>
              <div className="mb-3 grid grid-cols-4 gap-2">
                {CHIPS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={busy}
                    onClick={() => setAmount(String(c))}
                    className={`${btnSecondary} ${Number(amount) === c ? "ring-2 ring-[#14f195]" : ""}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <input
                id="tu-amt"
                aria-label="Custom amount in USDC"
                className={input}
                disabled={busy}
                required
                type="number"
                min="0.01"
                max={MAX_TOPUP}
                step="0.01"
                inputMode="decimal"
                placeholder="Custom amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="tu-reason">
                Note (optional)
              </label>
              <input
                id="tu-reason"
                className={input}
                disabled={busy}
                maxLength={200}
                placeholder="e.g. Weekend groceries"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <button
              className={`${btnPrimary} w-full`}
              disabled={busy || !(Number(amount) > 0)}
              type="submit"
            >
              {busy
                ? "Starting…"
                : Number(amount) > 0
                  ? `Add ${usd(Number(amount))} USDC`
                  : "Add funds"}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded bg-[#211d2d] p-5">
              <p className="text-xs font-medium uppercase tracking-wider text-[#a9a5b9]">
                {ready ? "Adding now" : "Safety wait"}
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight">
                {usd(toUsdc(topup.amount))}
              </p>
              {topup.reason && (
                <p className="mt-2 text-sm text-[#a9a5b9]">{topup.reason}</p>
              )}
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              aria-label="Safety wait progress"
              className="h-2 w-full overflow-hidden rounded bg-[#373041]"
            >
              <div
                className="h-full bg-[#14f195] transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-sm font-medium" role="status">
              {ready
                ? busy
                  ? "Adding to your pouch…"
                  : "Wait is over."
                : `Funds will be added in ${seconds}s. Keep this page open.`}
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                className={`${btnPrimary} flex-1`}
                disabled={!ready || busy}
                onClick={() => void complete(false)}
              >
                {busy && ready ? "Adding…" : "Add now"}
              </button>
              <button
                className={btnSecondary}
                disabled={busy}
                onClick={() => void cancel()}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
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

  const pouchReady = pouch?.id === id;
  useEffect(() => {
    if (pouchReady && window.location.hash === "#add-funds")
      document
        .getElementById("add-funds")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pouchReady]);

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
        className="inline-flex items-center gap-2 text-sm font-medium text-[#14f195] hover:text-[#14f195]"
      >
        ← All pouches
      </Link>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#a9a5b9]">
            Your pouch
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {pouch.name}
          </h1>
        </div>
        <span
          className={`rounded px-4 py-2 text-xs font-medium ${pouch.frozen ? "bg-[#23243d] text-[#b9baff]" : "bg-[#102e24] text-[#14f195]"}`}
        >
          {pouch.frozen ? "●  Frozen" : "●  Active"}
        </span>
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
      <TopUpSection key={pouch.id} pouch={pouch} onDone={load} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
        <div className="min-w-0 space-y-6">
          <section className="border-b border-[#373041] pb-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[#d9d1e6]">Available balance</p>
                <p className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
                  {usd(toUsdc(pouch.balance))}
                </p>
                <p className="mt-2 text-xs text-[#bcb3cc]">
                  USDC · Pouch balance
                </p>
              </div>
            </div>
            <div className="mt-8 border-t border-white/15 pt-5">
              <div className="mb-3 flex flex-wrap justify-between gap-2 text-sm">
                <span className="text-[#d9d1e6]">Today's spending</span>
                <span>
                  {usd(toUsdc(pouch.spentToday))}{" "}
                  <span className="text-[#bcb3cc]">
                    / {usd(toUsdc(pouch.dailyLimit))}
                  </span>
                </span>
              </div>
              <Progress value={pouch.spentToday} max={pouch.dailyLimit} />
              <p className="mt-3 text-xs text-[#d9d1e6]">
                {usd(toUsdc(available))} remaining under your daily limit
              </p>
            </div>
          </section>
          <section className={card}>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold tracking-tight">
                Spending activity
              </h2>
              <span className="rounded bg-[#211d2d] px-3 py-1 text-xs text-[#a9a5b9]">
                Daily (UTC) · USDC
              </span>
            </div>
            {chart.length === 0 ? (
              <div className="py-8 text-sm text-[#a9a5b9]">
                <p className="font-medium">No spending yet.</p>
                <p className="mt-2 text-sm text-[#a9a5b9]">
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
                      stroke="#373041"
                    />
                    <XAxis
                      dataKey="bucket"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "#a9a5b9", fontSize: 11 }}
                      dy={8}
                    />
                    <YAxis
                      tickFormatter={(v) => `$${v}`}
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "#a9a5b9", fontSize: 11 }}
                    />
                    <Tooltip
                      formatter={(v) => usd(Number(v))}
                      contentStyle={{
                        borderRadius: 4,
                        background: "#1c1826",
                        color: "#f1edf8",
                        border: "1px solid #373041",
                        fontSize: 13,
                      }}
                      cursor={{ fill: "#211d2d" }}
                    />
                    <Bar
                      name="Spent"
                      dataKey="spent"
                      fill="#14f195"
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
              <span className="text-xs text-[#a9a5b9]">
                {orders.length} {orders.length === 1 ? "order" : "orders"}
              </span>
            </div>
            {orders.length === 0 ? (
              <div className="py-7 text-center">
                <p className="font-medium">No orders yet.</p>
                <p className="mt-2 text-sm text-[#a9a5b9]">
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
              <ul className="divide-y divide-[#373041]">
                {orders.map((o) => (
                  <li key={o.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <Link
                          href={`/order?order=${encodeURIComponent(o.id)}`}
                          className="break-words text-sm font-medium text-[#14f195] underline decoration-[#705293] underline-offset-4 hover:decoration-[#14f195]"
                        >
                          {o.request}
                        </Link>
                        <p className="mt-1 text-xs text-[#a9a5b9]">
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
                        className={`rounded px-2.5 py-1 text-[11px] font-medium capitalize ${o.status === "rejected" ? "bg-[#361c28] text-[#ffa6bb]" : o.status === "paid" ? "bg-[#102e24] text-[#14f195]" : "bg-[#211d2d] text-[#a9a5b9]"}`}
                      >
                        {o.status === "draft" ? "Awaiting approval" : o.status}
                      </span>
                      {o.rejectReason && (
                        <span className="text-xs text-[#ffa6bb]">
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
            <p className="mb-5 text-sm leading-6 text-[#a9a5b9]">
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
            <div className="mt-6 border-t border-[#373041] pt-5">
              <div className="mb-4">
                <h3 className="text-sm font-medium">
                  {pouch.frozen ? "Resume payments" : "Pause payments"}
                </h3>
                <p className="mt-1 text-xs leading-5 text-[#a9a5b9]">
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
        </div>
      </div>
    </div>
  );
}
