"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { WalletLink, injectedWallet, shortAddress } from "@/components/WalletLink";
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
  Withdrawal,
} from "@solpouch/shared";
import { toMicros, toUsdc } from "@solpouch/shared";
import { api, ApiRequestError, errMsg } from "@/lib/api";
import { explorerTxUrl } from "@/lib/explorer";
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

const explorerUrl = (kind: "tx" | "address", value: string) =>
  `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}?cluster=devnet`;
const shorten = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

const CHIPS = [10, 25, 50, 100];
const MAX_TOPUP = 10000;
// The wait comes from the backend's cooldown, so only show a number once the top-up tells us.
const steps = (waitSeconds: number | null) => [
  "Choose amount",
  waitSeconds ? `Short safety wait (${waitSeconds} s)` : "Short safety wait",
  "Added to pouch",
];

function MoveFromWalletSection({
  pouch,
  onDone,
}: {
  pouch: Pouch;
  onDone: () => Promise<void>;
}) {
  const { user, sessionKey, updateUser } = useAuth();
  const wallet = user?.wallet;
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [hasProvider, setHasProvider] = useState(true);
  useEffect(() => {
    setHasProvider(Boolean(injectedWallet()));
  }, []);

  async function move(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !wallet) return;
    const n = Number(amount);
    const micros = toMicros(n);
    if (!(n > 0) || !Number.isSafeInteger(micros) || micros <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    if (n > MAX_TOPUP) {
      setError(`The most you can move at once is ${MAX_TOPUP.toLocaleString()} USDC.`);
      return;
    }
    const provider = injectedWallet();
    if (!provider) {
      setHasProvider(false);
      return;
    }
    setBusy(true);
    setError(null);
    setMoved(null);
    try {
      const conn = await provider.connect();
      if (conn.publicKey.toBase58() !== wallet) {
        setError(`Switch Phantom to your linked wallet ${shortAddress(wallet)}`);
        return;
      }
      const prep = await api.prepareAllocation(pouch.id, micros);
      const web3 = await import("@solana/web3.js");
      const tx = web3.Transaction.from(
        Uint8Array.from(atob(prep.transaction), (c) => c.charCodeAt(0)),
      );
      let signature: string;
      if (provider.signAndSendTransaction) {
        signature = (await provider.signAndSendTransaction(tx)).signature;
      } else if (provider.signTransaction) {
        const signed = (await provider.signTransaction(tx)) as InstanceType<
          typeof web3.Transaction
        >;
        const connection = new web3.Connection(
          process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? web3.clusterApiUrl("devnet"),
          "confirmed",
        );
        signature = await connection.sendRawTransaction(signed.serialize());
      } else {
        setError("This wallet cannot sign transactions. Try Phantom.");
        return;
      }
      const deadline = Date.now() + 60000;
      for (;;) {
        try {
          await api.completeAllocation(prep.allocationId, signature);
          break;
        } catch (err) {
          if (!(err instanceof ApiRequestError && err.status === 422) || Date.now() > deadline)
            throw err;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      setMoved(`Moved ${usd(n)} USDC into this pouch`);
      setAmount("");
      await onDone();
    } catch (err) {
      const x = err as { code?: number; message?: string };
      if (x?.code === 4001 || /reject/i.test(x?.message ?? "")) setError("Cancelled in wallet");
      else {
        if (err instanceof ApiRequestError && err.code === "WalletRequired" && sessionKey)
          updateUser({ wallet: undefined }, sessionKey);
        setError(errMsg(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <div className="mb-4">
        <h2 className="text-lg font-semibold tracking-tight">Move from wallet</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Send USDC from your linked wallet into this pouch.
        </p>
      </div>
      <ErrorBanner message={error} />
      {moved && <Notice>{moved}</Notice>}
      {!wallet && <p className="text-sm text-[var(--ink)]">Link a wallet first</p>}
      {wallet && !hasProvider && (
        <p className="text-sm text-[var(--ink)]">
          Open Solpouch in the Phantom app&apos;s browser to sign.
        </p>
      )}
      <form onSubmit={move} className="mt-3 space-y-3">
        <div>
          <label className={label} htmlFor={`move-${pouch.id}`}>Amount · USDC</label>
          <input
            id={`move-${pouch.id}`}
            className={input}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="25"
          />
        </div>
        <button className={btnPrimary} disabled={busy || !wallet || !amount}>
          {busy ? "Waiting for wallet…" : "Move to pouch"}
        </button>
      </form>
    </section>
  );
}

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
  const [addedTx, setAddedTx] = useState<string | null>(null);
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
        // A failed top-up cannot be completed (409), so show it as a notice instead.
        const open = list.find((t) => t.status !== "failed");
        const failed = list.find((t) => t.status === "failed");
        if (live && open) {
          setTopup((cur) => cur ?? open);
          setNow(Date.now());
        } else if (live && failed) {
          setError(
            `Your last top-up failed (${failed.failReason ?? "rejected"}). No money was added. You can start a new one.`,
          );
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
  const ready = topup != null && now >= readyAt + 2000;
  const processing = topup?.status === "processing";
  const seconds = Math.ceil(remaining / 1000);
  const total = topup
    ? Math.max(1000, readyAt - new Date(topup.createdAt).getTime())
    : 60000;
  const waitMs = topup ? Date.parse(topup.readyAt) - Date.parse(topup.createdAt) : NaN;
  const stepLabels = steps(waitMs > 0 ? Math.round(waitMs / 1000) : null);
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
        setAddedTx(completed.txSignature ?? null);
        setTopup(null);
        setAmount("");
        setReason("");
        setAutoFailed(false);
        await onDone();
      } catch (err) {
        setAutoFailed(true);
        setError(auto ? `Could not add automatically. ${errMsg(err)}` : errMsg(err));
        try {
          const latest = await api.topUp(topup.id);
          if (latest.status === "completed") {
            setTopup(null);
            setAdded(`Added ${usd(toUsdc(latest.amount))} USDC to ${pouch.name}`);
            setError(null);
            await onDone();
          } else if (latest.status === "failed" || latest.status === "cancelled") {
            setTopup(null);
            setError(`This top-up is ${latest.status}. You can start a new request.`);
          } else setTopup(latest);
        } catch { /* Preserve the request identity until its result can be checked. */ }
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
    if (busy || resumeLoading || resumeError || !hasWallet) return;
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
          <p className="mt-1 text-xs text-[var(--muted)]">
            Devnet demo funds — your wallet isn&apos;t charged.
          </p>
        </div>
        <ol className="mb-5 grid grid-cols-3 gap-2" aria-label="Top-up steps">
          {stepLabels.map((s, i) => {
            const n = i + 1;
            const on = n <= step;
            return (
              <li
                key={s}
                aria-current={n === step ? "step" : undefined}
                className={`flex flex-col gap-1 border-t-2 pt-2 text-xs leading-4 sm:text-xs ${on ? "border-[var(--ok)] text-[var(--ink)]" : "border-[var(--line-strong)] text-[var(--muted)]"}`}
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
        {error && /insufficient|not enough|balance/i.test(error) && <Link className="underline text-sm" href="/funding">Add money to your wallet</Link>}
        {added && (
          <Notice>
            {added}
            {explorerTxUrl(addedTx) && (
              <>
                {" · "}
                <a target="_blank" rel="noopener noreferrer" className="underline" href={explorerTxUrl(addedTx)!}>
                  View transaction ↗
                </a>
              </>
            )}
          </Notice>
        )}
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

const DAY_MS = 86_400_000;
// "x days y h left", dropping to hours and minutes in the last day.
const timeLeft = (ms: number) => {
  if (ms <= 0) return "releasing now";
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / 3_600_000);
  if (days > 0) return `${days} ${days === 1 ? "day" : "days"} ${hours} h left`;
  return `${hours} h ${Math.floor((ms % 3_600_000) / 60_000)} min left`;
};

const holdText = (seconds: number) => {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds >= 86_400 && seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds >= 3_600) return plural(Math.round(seconds / 3_600), "hour");
  if (seconds >= 60) return plural(Math.round(seconds / 60), "minute");
  return plural(Math.max(1, Math.round(seconds)), "second");
};

function WithdrawSection({
  pouch,
  onDone,
  onHeld,
}: {
  pouch: Pouch;
  onDone: () => Promise<void>;
  // Reports the amount held by withdrawals so the header can show what is spendable.
  onHeld: (held: number) => void;
}) {
  const { user, sessionKey, updateUser } = useAuth();
  const hasWallet = Boolean(user?.wallet);
  const [list, setList] = useState<Withdrawal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [amount, setAmount] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null while loading or if the request failed (older backend, network).
  const [cfg, setCfg] = useState<{ holdSeconds: number; simulated: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    api.withdrawalConfig().then((c) => { if (live) setCfg(c); }).catch(() => {});
    return () => { live = false; };
  }, [sessionKey]);

  const refresh = useCallback(async () => {
    const l = await api.listWithdrawals(pouch.id);
    setList(l);
    setLoaded(true);
    setLoadFailed(false);
    onHeld(
      l
        .filter((w) => w.status === "holding" || w.status === "processing")
        .reduce((sum, w) => sum + w.amount, 0),
    );
  }, [pouch.id, onHeld]);

  // Withdrawals only change slowly, so poll every 30 s and tick the countdown each minute.
  useEffect(() => {
    const fail = () => {
      setLoaded(true);
      setLoadFailed(true);
    };
    void refresh().catch(fail);
    const poll = setInterval(() => void refresh().catch(fail), 30_000);
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      onHeld(0);
    };
  }, [refresh, onHeld]);

  // Newest first from the backend: the live one wins, else the latest finished one.
  const active = list.find((w) => w.status === "holding" || w.status === "processing");
  const last = active ?? list.find((w) => w.status === "completed" || w.status === "failed");
  const held = list
    .filter((w) => w.status === "holding" || w.status === "processing")
    .reduce((sum, w) => sum + w.amount, 0);
  const maxAmount = toUsdc(Math.max(0, pouch.balance - held));

  async function start(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!(value > 0)) return;
    if (value > maxAmount) {
      setError("This is more than the available balance.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.startWithdrawal({ pouchId: pouch.id, amount: toMicros(value) });
      setAmount("");
      await refresh();
      await onDone();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "WalletRequired" && sessionKey)
        updateUser({ wallet: undefined }, sessionKey);
      setError(errMsg(err));
      void refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.cancelWithdrawal(id);
      await refresh();
      await onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <h2 className="mb-5 text-lg font-semibold tracking-tight">Withdraw</h2>
      <ErrorBanner message={error} />
      {loadFailed && !active ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted)]" role="alert">
            Could not check withdrawals.
          </p>
          <button
            className={btnSecondary}
            onClick={() => void refresh().catch(() => setLoadFailed(true))}
          >
            Retry
          </button>
        </div>
      ) : !loaded ? (
        <p className="text-sm text-[var(--muted)]" role="status">
          Checking withdrawals…
        </p>
      ) : active?.status === "holding" ? (
        <div className="space-y-4">
          <div className="rounded bg-[var(--surface-raised)] p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
              On hold
            </p>
            <p className="mt-2 text-3xl font-semibold tracking-tight">
              {usd(toUsdc(active.amount))}
            </p>
            <p className="mt-2 text-sm text-[var(--muted)]">
              To {shorten(active.toWallet)}
            </p>
          </div>
          {pouch.frozen && new Date(active.readyAt).getTime() <= now ? (
            <p className="text-sm" role="status">
              Paused while this pouch is frozen
            </p>
          ) : (
            <p className="text-sm" role="status">
              Releases {new Date(active.readyAt).toLocaleString()} ·{" "}
              <span className="font-medium">
                {timeLeft(new Date(active.readyAt).getTime() - now)}
              </span>
            </p>
          )}
          <button
            className={btnSecondary}
            disabled={busy}
            onClick={() => void cancel(active.id)}
          >
            {busy ? "Cancelling…" : "Cancel withdrawal"}
          </button>
        </div>
      ) : active ? (
        <div className="space-y-4">
          <p className="text-sm font-medium" role="status">
            Sending to your wallet…
          </p>
          {now - new Date(active.readyAt).getTime() > 10 * 60_000 && (
            <button
              className={btnSecondary}
              disabled={busy}
              onClick={() => void cancel(active.id)}
            >
              {busy ? "Cancelling…" : "Cancel withdrawal"}
            </button>
          )}
        </div>
      ) : !hasWallet ? (
        <p className="text-sm text-[var(--muted)]">
          A linked wallet is needed to withdraw money.
        </p>
      ) : pouch.frozen ? (
        <p className="text-sm text-[var(--muted)]">Unfreeze this pouch to withdraw.</p>
      ) : (
        <div className="space-y-4">
          {last?.status === "completed" && (
            <Notice>
              {!cfg
                ? `Withdrawal of ${usd(toUsdc(last.amount))} completed.`
                : cfg.simulated
                  ? `Demo withdrawal of ${usd(toUsdc(last.amount))}, no USDC moved.`
                  : `${usd(toUsdc(last.amount))} USDC was sent to your wallet.`}
              {cfg && !cfg.simulated && explorerTxUrl(last.txSignature) && (
                <>
                  {" "}
                  <a
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                    href={explorerTxUrl(last.txSignature)!}
                  >
                    View transaction ↗
                  </a>
                </>
              )}
            </Notice>
          )}
          {last?.status === "failed" && (
            <ErrorBanner
              message={`Your last withdrawal failed (${last.failReason ?? "rejected"}). No money left the pouch, so you can request again.`}
            />
          )}
          <form onSubmit={start} className="space-y-4">
            <div>
              <label className={label} htmlFor="wd-amt">
                Amount · USDC
              </label>
              <input
                id="wd-amt"
                className={input}
                disabled={busy}
                required
                type="number"
                min="0.01"
                max={maxAmount}
                step="0.01"
                inputMode="decimal"
                placeholder={`Up to ${usd(maxAmount)}`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <p className="text-sm text-[var(--muted)]">
              {cfg
                ? cfg.holdSeconds > 0
                  ? `Withdrawals are held for ${holdText(cfg.holdSeconds)} for fraud checks. You can cancel any time before then.`
                  : "Withdrawals are sent right away, so they can't be cancelled."
                : "Withdrawals are held for a waiting period before they are sent. You can cancel any time before then."}
              {!cfg || cfg.holdSeconds > 0 ? " Held money can’t be spent." : ""}
            </p>
            <button
              className={`${btnPrimary} w-full`}
              disabled={busy || !(Number(amount) > 0)}
              type="submit"
            >
              {busy ? "Requesting…" : "Request withdrawal"}
            </button>
          </form>
        </div>
      )}
    </section>
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
  const [heldMicros, setHeldMicros] = useState(0);
  const loadVersion = useRef(0);
  const merchantsLoaded = useRef(false);

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
      // Merchants rarely change: fetch on a full load or until first success, not every poll.
      const needMerchants = !quiet || !merchantsLoaded.current;
      const [m, o, s] = await Promise.all([
        needMerchants ? api.merchants() : Promise.resolve(null),
        api.orders(id),
        api.spend(id, "day"),
      ]);
      if (version !== loadVersion.current) return;
      setPouch(p);
      if (m) {
        setMerchants(m);
        merchantsLoaded.current = true;
      }
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
        href="/pouches"
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
          {pouch.address && (
            <p className="mt-2 text-xs text-[var(--muted)]">
              On-chain:{" "}
              <a
                target="_blank"
                rel="noopener noreferrer"
                className="num underline"
                href={explorerUrl("address", pouch.address)}
              >
                {shorten(pouch.address)} ↗
              </a>
            </p>
          )}
          <p className="num mt-3 text-3xl font-semibold">
            {usd(toUsdc(pouch.balance))}{" "}
            <span className="text-sm font-normal text-[var(--muted)]">
              USDC balance
            </span>
          </p>
          {heldMicros > 0 && (
            <p className="num mt-1 text-sm text-[var(--muted)]">
              <span className="text-[var(--ink)]">
                {usd(toUsdc(Math.max(0, pouch.balance - heldMicros)))}
              </span>{" "}
              available to spend ({usd(toUsdc(heldMicros))} on hold)
            </p>
          )}
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
      <MoveFromWalletSection key={`m-${pouch.id}`} pouch={pouch} onDone={load} />
      <WithdrawSection
        key={`w-${pouch.id}`}
        pouch={pouch}
        onDone={load}
        onHeld={setHeldMicros}
      />
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
                      {explorerTxUrl(o.txSignature) && (
                        <a
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-[var(--muted)] underline"
                          href={explorerTxUrl(o.txSignature)!}
                          aria-label="View receipt on Solana Explorer (opens in a new tab)"
                        >
                          receipt ↗
                        </a>
                      )}
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
                loadVersion.current++;
                setLoading(false); // a superseded full load no longer clears it
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
                  loadVersion.current++;
                  setLoading(false); // a superseded full load no longer clears it
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
