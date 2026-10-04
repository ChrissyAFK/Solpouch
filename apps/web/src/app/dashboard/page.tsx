"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatePanel } from "@/components/StatePanel";
import { MetricsSkeleton, RowsSkeleton } from "@/components/Skeletons";
import { useCallback, useEffect, useState } from "react";
import type { Merchant, Order, Pouch } from "@solpouch/shared";
import { toUsdc } from "@solpouch/shared";
import { api, errMsg } from "@/lib/api";
import { useLiveRefresh } from "@/lib/useLiveRefresh";
import { ErrorBanner, Notice, btnPrimary, btnSecondary, usd } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { PouchList, usePouchToggle } from "@/components/PouchList";
import { OrderList, sortOrders } from "@/components/OrderList";

export default function OverviewPage() {
  const router = useRouter();
  const [pouches, setPouches] = useState<Pouch[] | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [activityLoading, setActivityLoading] = useState(true);
  // quiet: background refresh, keeps what is on screen and skips loading states.
  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setActivityLoading(true);
      setLoadError(false);
      setError(null);
    }
    try {
      const [p, m] = await Promise.all([api.pouches(), api.merchants()]);
      setPouches(p);
      setMerchants(m);
      setLoadError(false);
      setError(null);
    } catch (e) {
      if (!quiet) {
        setLoadError(true);
        setError(errMsg(e));
      }
    } finally {
      if (!quiet) setLoading(false);
    }
    try {
      setOrders(await api.orders());
      setActivityError(false);
    } catch {
      if (!quiet) setActivityError(true);
    } finally {
      if (!quiet) setActivityLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    // Old in-page anchors now live on their own pages.
    if (window.location.hash === "#pouches") router.replace("/pouches");
    else if (window.location.hash === "#activity") router.replace("/orders");
  }, [router]);
  useLiveRefresh(useCallback(() => load(true), [load]));
  const { busy, notice, toggle } = usePouchToggle(
    useCallback(() => load(), [load]),
    setError,
  );
  const balance = pouches?.reduce((s, p) => s + p.balance, 0) ?? 0;
  const spent = pouches?.reduce((s, p) => s + p.spentToday, 0) ?? 0;
  const limit = pouches?.reduce((s, p) => s + p.dailyLimit, 0) ?? 0;
  const active = pouches?.filter((p) => !p.frozen).length ?? 0;
  const recent = sortOrders(orders ?? []).slice(0, 5);
  return (
    <div className="overview">
      <div className="page-heading">
        <h1>Overview</h1>
        <Link href="/order" className={btnPrimary}>
          <Icon name="plus" size={16} /> New order
        </Link>
      </div>
      <ErrorBanner message={error} />
      {error && !loadError && (
        <button className={btnSecondary} onClick={() => void load()}>
          Retry connection
        </button>
      )}
      {notice && <Notice>{notice}</Notice>}
      {loading ? (
        <MetricsSkeleton />
      ) : loadError ? (
        <StatePanel
          title="Pouches couldn’t be loaded"
          retry={() => void load()}
        >
          Balances and spending controls are unavailable. Try reconnecting to
          load your dashboard.
        </StatePanel>
      ) : (
        <section className="wallet-metrics" aria-label="Spending overview">
          <div className="wallet-metric">
            <p>Balance</p>
            <strong>{pouches ? usd(toUsdc(balance)) : "—"}</strong>
            <span>USDC across {pouches?.length ?? "—"} pouches</span>
          </div>
          <div className="wallet-metric">
            <p>Spent today</p>
            <strong>
              {pouches ? usd(toUsdc(spent)) : "—"}
              <span> / {pouches ? usd(toUsdc(limit)) : "—"}</span>
            </strong>
          </div>
          <div className="wallet-metric">
            <p>Active</p>
            <strong>
              {pouches ? active : "—"}
              <span> / {pouches?.length ?? "—"}</span>
            </strong>
            {pouches && pouches.length - active > 0 && (
              <span>{pouches.length - active} frozen</span>
            )}
          </div>
        </section>
      )}
      <section className="wallet-section">
        <div className="section-heading">
          <h2>
            Pouches{" "}
            <span className="section-count">{pouches?.length ?? "—"}</span>
          </h2>
          <Link href="/pouches" className={btnSecondary}>
            View all pouches <Icon name="arrow" size={15} />
          </Link>
        </div>
        {loading && <RowsSkeleton />}
        {!loading && !loadError && pouches?.length === 0 && (
          <p className="table-empty">
            No pouches yet. Create a pouch first, then add funds to it.
          </p>
        )}
        {!loading && !loadError && pouches && pouches.length > 0 && (
          <PouchList
            pouches={pouches.slice(0, 3)}
            busy={busy}
            onToggle={(p) => void toggle(p)}
          />
        )}
      </section>
      <section className="wallet-section orders-section">
        <div className="section-heading">
          <h2>Recent orders</h2>
          <Link href="/orders" className={btnSecondary}>
            View all orders <Icon name="arrow" size={15} />
          </Link>
        </div>
        {activityLoading ? (
          <RowsSkeleton kind="orders" />
        ) : activityError ? (
          <div className="table-empty">
            <p>Orders couldn&apos;t be loaded.</p>
            <button className={btnSecondary} onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : orders === null ? (
          <RowsSkeleton kind="orders" />
        ) : recent.length === 0 ? (
          <div className="table-empty">
            <p>No orders yet.</p>
            <span>Use New order to build a cart.</span>
          </div>
        ) : (
          <OrderList orders={recent} merchants={merchants} pouches={pouches} />
        )}
      </section>
    </div>
  );
}
