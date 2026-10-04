"use client";
import { useRequestScope } from "@/lib/useRequestScope";
import Link from "next/link";
import { RowsSkeleton } from "@/components/Skeletons";
import { useCallback, useEffect, useState } from "react";
import type { Merchant, Order, Pouch } from "@solpouch/shared";
import { api } from "@/lib/api";
import { useLiveRefresh } from "@/lib/useLiveRefresh";
import { downloadFile, ordersCsv } from "@/lib/orderExport";
import { btnPrimary, btnSecondary } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { OrderList, sortOrders } from "@/components/OrderList";

export default function OrdersPage() {
  const [pouchFilter, setPouchFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [storeFilter, setStoreFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [pouches, setPouches] = useState<Pouch[] | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const beginRequest = useRequestScope();
  const load = useCallback(async (quiet = false) => {
    const current = beginRequest();
    if (!quiet) {
      setLoading(true);
      setFailed(false);
    }
    try {
      const [o, p, m] = await Promise.all([
        api.orders(),
        api.pouches().catch(() => null),
        api.merchants().catch(() => [] as Merchant[]),
      ]);
      if (!current()) return;
      setOrders(o);
      setPouches(p);
      setMerchants(m);
      setFailed(false);
    } catch {
      if (current()) setFailed(true);
    } finally {
      if (current()) setLoading(false);
    }
  }, [beginRequest]);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(useCallback(() => load(true), [load]));
  const storeName = (order: Order) => order.store?.name ?? order.store?.domain ?? merchants.find(m => m.id === order.merchantId)?.name ?? order.merchantId;
  const sorted = sortOrders(orders ?? []).filter(order => {
    const date = new Date(order.createdAt);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return (!pouchFilter || order.pouchId === pouchFilter) && (!statusFilter || order.status === statusFilter) && (!storeFilter || order.merchantId === storeFilter) && (!from || day >= from) && (!to || day <= to) && (!search.trim() || `${order.id} ${order.request} ${storeName(order)}`.toLowerCase().includes(search.trim().toLowerCase()));
  });
  const stores = [...new Map((orders ?? []).map(order => [order.merchantId, storeName(order)])).entries()];
  return (
    <div className="overview">
      <div className="page-heading">
        <h1>Orders</h1>
        <Link href="/order" className={btnPrimary}>
          <Icon name="plus" size={16} /> New order
        </Link>
      </div>
      <section className="sp-card mb-5 space-y-4" aria-label="Filter order history">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="sp-label">Search orders<input className="sp-input" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Order, item or store" /></label>
          <label className="sp-label">Pouch<select aria-label="Pouch" className="sp-input" value={pouchFilter} onChange={e => setPouchFilter(e.target.value)}><option value="">All pouches</option>{pouches?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="sp-label">Status<select aria-label="Status" className="sp-input" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All statuses</option>{["draft", "confirmed", "paying", "paid", "rejected", "cancelled"].map(status => <option key={status}>{status}</option>)}</select></label>
          <label className="sp-label">Store<select aria-label="Store" className="sp-input" value={storeFilter} onChange={e => setStoreFilter(e.target.value)}><option value="">All stores</option>{stores.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label className="sp-label">From date<input className="sp-input" type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} /></label>
          <label className="sp-label">To date<input className="sp-input" type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button className={btnSecondary} onClick={() => { setSearch(""); setPouchFilter(""); setStatusFilter(""); setStoreFilter(""); setFrom(""); setTo(""); }}>Clear filters</button>
          <button className={btnSecondary} disabled={loading || failed || !sorted.length} onClick={() => downloadFile("solpouch-orders.csv", ordersCsv(sorted, id => pouches?.find(p => p.id === id)?.name ?? id, storeName), "text/csv;charset=utf-8")}>Export filtered CSV</button>
          {!loading && <span className="text-sm text-[var(--muted)]">{sorted.length} of {orders?.length ?? 0} orders</span>}
        </div>
      </section>
      <section id="activity" className="wallet-section orders-section">
        <div className="section-heading">
          <h2>
            Orders <span className="section-count">{orders?.length ?? "—"}</span>
          </h2>
        </div>
        {loading ? (
          <RowsSkeleton kind="orders" />
        ) : failed ? (
          <div className="table-empty">
            <p>Orders couldn&apos;t be loaded.</p>
            <button className={btnSecondary} onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : sorted.length === 0 ? (
          <div className="table-empty">
            <p>{orders?.length ? "No orders match these filters." : "No orders yet."}</p>
            <Link href="/order" className={btnPrimary}>
              New order
            </Link>
          </div>
        ) : (
          <OrderList orders={sorted} merchants={merchants} pouches={pouches} />
        )}
      </section>
    </div>
  );
}
