"use client";
import Link from "next/link";
import { RowsSkeleton } from "@/components/Skeletons";
import { useCallback, useEffect, useState } from "react";
import type { Merchant, Order, Pouch } from "@solpouch/shared";
import { api } from "@/lib/api";
import { useLiveRefresh } from "@/lib/useLiveRefresh";
import { btnPrimary, btnSecondary } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { OrderList, sortOrders } from "@/components/OrderList";

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [pouches, setPouches] = useState<Pouch[] | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (quiet = false) => {
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
      setOrders(o);
      setPouches(p);
      setMerchants(m);
      setFailed(false);
    } catch {
      if (!quiet) setFailed(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(useCallback(() => load(true), [load]));
  const sorted = sortOrders(orders ?? []);
  return (
    <div className="overview">
      <div className="page-heading">
        <h1>Orders</h1>
        <Link href="/order" className={btnPrimary}>
          <Icon name="plus" size={16} /> New order
        </Link>
      </div>
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
            <p>No orders yet.</p>
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
