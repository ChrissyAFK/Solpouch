"use client";
import Link from "next/link";
import { StatePanel } from "@/components/StatePanel";
import { MetricsSkeleton, RowsSkeleton } from "@/components/Skeletons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Merchant, Order, Pouch } from "@solpouch/shared";
import { toUsdc } from "@solpouch/shared";
import { api, errMsg } from "@/lib/api";
import { PouchForm } from "@/components/PouchForm";
import {
  ErrorBanner,
  Notice,
  Progress,
  btnPrimary,
  btnSecondary,
  usd,
} from "@/components/ui";
import { Icon } from "@/components/Icons";

export default function PouchesPage() {
  const [pouches, setPouches] = useState<Pouch[] | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [activityLoading, setActivityLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const formRef = useRef<HTMLElement>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setActivityLoading(true);
    setLoadError(false);
    setError(null);
    try {
      const [p, m] = await Promise.all([api.pouches(), api.merchants()]);
      setPouches(p);
      setMerchants(m);
      setError(null);
    } catch (e) {
      setLoadError(true);
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
    try {
      setOrders(await api.orders());
      setActivityError(false);
    } catch {
      setActivityError(true);
    } finally {
      setActivityLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (showForm) {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      formRef.current?.querySelector("input")?.focus({ preventScroll: true });
    }
  }, [showForm]);
  async function toggle(p: Pouch) {
    setBusy(p.id);
    setNotice(null);
    try {
      await (p.frozen ? api.unfreeze(p.id) : api.freeze(p.id));
      await load();
      setNotice(`${p.name} ${p.frozen ? "unfrozen" : "frozen"}.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }
  const balance = pouches?.reduce((s, p) => s + p.balance, 0) ?? 0;
  const spent = pouches?.reduce((s, p) => s + p.spentToday, 0) ?? 0;
  const limit = pouches?.reduce((s, p) => s + p.dailyLimit, 0) ?? 0;
  const active = pouches?.filter((p) => !p.frozen).length ?? 0;
  const recent = [...(orders ?? [])]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 8);
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
          <div className="wallet-metric main-metric">
            <p>
              Balance <span>USDC</span>
            </p>
            <strong>{pouches ? usd(toUsdc(balance)) : "—"}</strong>
            <span>Across {pouches?.length ?? "—"} pouches</span>
          </div>
          <div className="wallet-metric">
            <p>Spent today</p>
            <strong>{pouches ? usd(toUsdc(spent)) : "—"}</strong>
            <span>{pouches ? usd(toUsdc(limit)) : "—"} daily limit</span>
          </div>
          <div className="wallet-metric">
            <p>Active pouches</p>
            <strong>
              {pouches ? active : "—"}
              <span> / {pouches?.length ?? "—"}</span>
            </strong>
            <span>
              {pouches ? `${pouches.length - active} frozen` : "Loading"}
            </span>
          </div>
        </section>
      )}
      <section id="pouches" className="wallet-section">
        <div className="section-heading">
          <h2>
            Pouches{" "}
            <span className="section-count">{pouches?.length ?? "—"}</span>
          </h2>
          <button
            disabled={loading || loadError}
            onClick={() => setShowForm(true)}
            className={btnSecondary}
          >
            <Icon name="plus" size={15} /> Create pouch
          </button>
        </div>
        {loading && <RowsSkeleton />}
        {!loading && !loadError && pouches?.length === 0 && (
          <p className="table-empty">
            No pouches. Create one to set a budget and add funds.
          </p>
        )}
        {!loading && !loadError && pouches && pouches.length > 0 && (
          <div className="pouch-table">
            <div className="pouch-table-head" aria-hidden="true">
              <span>Pouch</span>
              <span>Balance</span>
              <span>Daily spending</span>
              <span>Status</span>
              <span />
            </div>
            {pouches.map((p) => (
              <article className="pouch-row" key={p.id}>
                <div className="pouch-identity">
                  <h3>
                    <Link href={`/pouches/${p.id}`}>{p.name}</Link>
                  </h3>
                  <span>
                    {p.allowedMerchantIds.length}{" "}
                    {p.allowedMerchantIds.length === 1 ? "store" : "stores"} ·{" "}
                    {usd(toUsdc(p.maxPerOrder))} per order
                  </span>
                </div>
                <div className="pouch-row-balance">
                  <span className="mobile-label">Balance</span>
                  <strong>{usd(toUsdc(p.balance))}</strong>
                </div>
                <div className="pouch-row-spending">
                  <span className="mobile-label">Daily spending</span>
                  <div>
                    {usd(toUsdc(p.spentToday))}{" "}
                    <span>/ {usd(toUsdc(p.dailyLimit))}</span>
                  </div>
                  <Progress value={p.spentToday} max={p.dailyLimit} />
                </div>
                <span className={`pouch-status ${p.frozen ? "is-frozen" : ""}`}>
                  <span />
                  {p.frozen ? "Frozen" : "Active"}
                </span>
                <div className="row-actions">
                  <button
                    disabled={busy === p.id}
                    onClick={() => void toggle(p)}
                    aria-label={`${p.frozen ? "Unfreeze" : "Freeze"} ${p.name}`}
                  >
                    {busy === p.id
                      ? "Updating…"
                      : p.frozen
                        ? "Unfreeze"
                        : "Freeze"}
                  </button>
                  <Link
                    href={`/pouches/${p.id}`}
                    aria-label={`Manage ${p.name}`}
                  >
                    Manage <Icon name="arrow" size={14} />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
        {showForm && !loading && !loadError && (
          <section
            className="sp-card create-form-panel"
            ref={formRef}
            aria-label="Create a pouch"
          >
            <div className="section-heading">
              <h2>Create pouch</h2>
              <button
                className={btnSecondary}
                onClick={() => setShowForm(false)}
              >
                Close
              </button>
            </div>
            <PouchForm
              merchants={merchants}
              withName
              submitLabel="Create pouch"
              onSubmit={async (v) => {
                try {
                  await api.createPouch(v);
                  setShowForm(false);
                  await load();
                  setNotice("Pouch created. Open it to add funds.");
                } catch (e) {
                  setError(errMsg(e));
                  throw e;
                }
              }}
            />
          </section>
        )}
      </section>
      <section id="activity" className="wallet-section orders-section">
        <div className="section-heading">
          <h2>Orders</h2>
          <span className="section-note">
            Most recent {recent.length > 0 ? recent.length : "orders"}
          </span>
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
          <div className="orders-table">
            <div className="order-table-head" aria-hidden="true">
              <span>Store / Pouch</span>
              <span>Date</span>
              <span>Status</span>
              <span>Amount</span>
              <span />
            </div>
            {recent.map((o) => (
              <Link
                key={o.id}
                href={`/order?order=${encodeURIComponent(o.id)}`}
                className="order-row"
              >
                <span className="order-identity">
                  <strong>
                    {merchants.find((m) => m.id === o.merchantId)?.name ??
                      "Order"}
                  </strong>
                  <span>
                    {pouches?.find((p) => p.id === o.pouchId)?.name ?? "Pouch"}
                  </span>
                </span>
                <span className="order-date">
                  {new Date(o.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <span className={`order-status status-${o.status}`}>
                  {o.status === "draft" ? "Awaiting review" : o.status}
                </span>
                <strong className="order-amount">{usd(toUsdc(o.total))}</strong>
                <Icon name="arrow" size={15} />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
