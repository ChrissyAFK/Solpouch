"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { WalletLink } from "@/components/WalletLink";
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
import { PouchForm, storesText } from "@/components/PouchForm";
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
  const { user, sessionKey, updateUser } = useAuth();
  const hasWallet = Boolean(user?.wallet);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [topup, setTopup] = useState<TopUp | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoFailed, setAutoFailed] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(true);
  const [resumeError, setResumeError] = useState(false);
  const [resumeAttempt, setResumeAttempt] = useState(0);
  const completing = useRef(false);

  // Resume the newest pending top-up so a reload does not lose it.
  useEffect(() => {
    let live = true;
    setResumeLoading(true);
    setResumeError(false);
    api
      .listPendingTopUps(pouch.id)
      .then((list) => {
        if (live && list.length > 0) {
          setTopup((cur) => cur ?? list[0]);
          setNow(Date.now());
        }
      })
      .catch(() => { if (live) setResumeError(true); })
      .finally(() => { if (live) setResumeLoading(false); });
    return () => {
      live = false;
    };
  }, [pouch.id, resumeAttempt]);

  useEffect(() => {
    if (!topup || topup.status === "processing") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [topup]);

  const readyAt = topup ? new Date(topup.readyAt).getTime() : 0;
  const remaining = topup ? Math.max(0, readyAt - now) : 0;
  const ready = topup != null && remaining === 0;
  const processing = topup?.status === "processing";
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
        const completed = await api.completeTopUp(topup.id);
        if (completed.status !== "completed") {
          setTopup(completed);
          setAutoFailed(true);
          setError("The top-up is still being checked. Keep this top-up and check its status again.");
          return;
        }
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
    if (ready && !processing && !autoFailed && !completing.current) void complete(true);
  }, [ready, processing, autoFailed, complete]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (busy || resumeLoading || resumeError) return;
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
      // The server no longer sees a linked wallet: show the link prompt instead of the form.
      if (err instanceof ApiRequestError && err.code === "WalletRequired" && sessionKey)
        updateUser({ wallet: undefined }, sessionKey);
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!topup || busy || processing) return;
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
        <p className="rounded bg-[var(--surface-raised)] px-4 py-3 text-sm text-[var(--ink)]">
          This pouch is empty. Add funds to start spending.
        </p>
      )}
      <section className={card}>
        <div className="mb-4">
          <h2 className="text-lg font-semibold tracking-tight">Add funds</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
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
                className={`flex flex-col gap-1 border-t-2 pt-2 text-xs leading-4 sm:text-xs ${on ? "border-[var(--ok)] text-white" : "border-[var(--line-strong)] text-[var(--muted)]"}`}
              >
                <span className="font-semibold">{n}</span>
                <span>{s}</span>
              </li>
            );
          })}
        </ol>
        {resumeLoading && <p role="status">Checking pending top-ups…</p>}
        {resumeError && <div role="alert"><p>Pending top-ups could not be checked. Retry before adding more funds.</p><button className={btnSecondary} onClick={() => setResumeAttempt(n => n + 1)}>Retry pending top-ups</button></div>}
        {processing && <Notice><strong>Checking top-up</strong><p>The transfer result is not confirmed. Do not start another top-up for the same funds.</p><button className={btnSecondary} disabled={busy} onClick={() => void complete(false)}>Check top-up status</button></Notice>}
        <ErrorBanner message={error} />
        {added && <Notice>{added}</Notice>}
        {!topup && !hasWallet ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--ink)]">Link a wallet to add money. Top-ups are recorded against your linked wallet.</p>
            <WalletLink />
          </div>
        ) : !topup ? (
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
                    className={`${btnSecondary} ${Number(amount) === c ? "ring-2 ring-[var(--ok)]" : ""}`}
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
              disabled={busy || resumeLoading || resumeError || !(Number(amount) > 0)}
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
            <div className="rounded bg-[var(--surface-raised)] p-5">
              <p className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
                {ready ? "Adding now" : "Safety wait"}
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight">
                {usd(toUsdc(topup.amount))}
              </p>
              {topup.reason && (
                <p className="mt-2 text-sm text-[var(--muted)]">{topup.reason}</p>
              )}
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              aria-label="Safety wait progress"
              className="h-2 w-full overflow-hidden rounded bg-[var(--line-strong)]"
            >
              <div
                className="h-full bg-[var(--ok)] transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-sm font-medium" role="status">
              {processing ? "Checking the existing transfer." : ready
                ? busy
                  ? "Adding to your pouch…"
                  : "Wait is over."
                : `Funds will be added in ${seconds}s. Keep this page open.`}
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                className={`${btnPrimary} flex-1`}
                disabled={!ready || busy || processing}
                onClick={() => void complete(false)}
              >
                {busy && ready ? "Adding…" : "Add now"}
              </button>
              <button
                className={btnSecondary}
                disabled={busy || processing}
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
  const viewId = useRef(id);
  viewId.current = id;
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
    if (viewId.current !== id) return;
    // A quiet refresh never supersedes a full load, so it cannot strand the loading state.
    const version = ++loadVersion.current;
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
      if (version === loadVersion.current) setError(errMsg(e));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [id]);
  useLiveRefresh(useCallback(() => load(true), [load]));
  useEffect(() => {
    setPouch(null);
    setSaved(false);
    setFreezing(false);
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
              {storesText(pouch.allowedMerchantIds, mname)}
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
      <TopUpSection key={pouch.id} pouch={pouch} onDone={load} />
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
            <p className="mb-3 text-xs text-[var(--muted)]">Payments without a recorded payment date are excluded.</p>
            {chart.length === 0 ? (
              <div className="py-8 text-sm text-[var(--muted)]">
                <p className="font-medium">No dated payments yet.</p>
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
                if (viewId.current !== id) return;
                loadVersion.current++;
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
                    if (viewId.current !== id) return;
                    loadVersion.current++;
                    setPouch(updated);
                  } catch (e) {
                    if (viewId.current === id) setError(errMsg(e));
                  } finally {
                    if (viewId.current === id) setFreezing(false);
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
