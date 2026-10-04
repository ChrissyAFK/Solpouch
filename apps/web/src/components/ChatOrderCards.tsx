"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { isCheckoutReference, orderCurrency, toUsdc, type Order } from "@solpouch/shared";
import { api, errMsg } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useAuth } from "./AuthProvider";
import styles from "./ChatWidget.module.css";

/** Account-backed cards; never extract payment instructions from model text. */
export function ChatOrderCards({ refreshKey }: { refreshKey: number }) {
  const { sessionKey } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const current = () => mounted.current && getToken() === sessionKey;
  const load = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const result = await api.orders();
      if (!mounted.current || getToken() !== sessionKey || id !== sequence.current) return;
      setOrders(result.slice(0, 3));
      setUpdated(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setError(null);
    } catch (cause) {
      if (mounted.current && getToken() === sessionKey && id === sequence.current) setError(errMsg(cause));
    }
  }, [sessionKey]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => { if (sessionKey) void load(); }, [load, refreshKey, sessionKey]);
  async function confirm(order: Order) {
    if (!current() || busy || isCheckoutReference(order)) return;
    setBusy(order.id);
    setError(null);
    try {
      const result = await api.confirm(order.id, order.version ?? 0);
      if (!current()) return;
      sequence.current++;
      setOrders(list => list.map(item => item.id === result.id ? result : item));
      setUpdated(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch (cause) {
      if (current()) setError(errMsg(cause));
    } finally {
      if (current()) setBusy(null);
    }
  }
  return (
    <section className={styles.orderCards} aria-label="Recent carts and payments">
      <div className={styles.cardHeading}>
        <strong>Your carts</strong>
        <button type="button" disabled={!!busy} onClick={() => void load()}>Refresh carts</button>
      </div>
      {updated && <small>Updated {updated}</small>}
      {error && <p role="alert">{error}</p>}
      {orders.length === 0 && <p>No carts yet. Use New order to build one.</p>}
      {orders.map(order => {
        const reference = isCheckoutReference(order);
        const currency = `${orderCurrency(order)}${reference ? " estimate" : ""}`;
        const total = toUsdc(order.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return (
          <article key={order.id} className={styles.orderCard}>
            <strong>{order.store?.name ?? order.merchantId}</strong>
            <span>{order.status === "paying" ? "Payment confirmation pending" : order.status}</span>
            <ul>{order.lines.map((line, index) => <li key={index}>{line.qty} × {line.product?.name ?? line.requested}{line.substitution ? " · substitution" : ""}{line.note ? ` — ${line.note}` : ""}</li>)}</ul>
            <b>{total} {currency}</b>
            {reference && <p>Check the retailer’s price and complete checkout there. No retailer purchase is confirmed.</p>}
            <Link href={`/order?order=${encodeURIComponent(order.id)}`}>Review cart and receipt</Link>
            {reference && order.fulfillment?.checkoutUrl && /^https?:\/\//i.test(order.fulfillment.checkoutUrl) && <a href={order.fulfillment.checkoutUrl} target="_blank" rel="noopener noreferrer">Open retailer checkout ↗</a>}
            {!reference && (order.status === "draft" || order.status === "paying") && <button type="button" disabled={!!busy || order.total <= 0} onClick={() => void confirm(order)}>{busy === order.id ? "Checking…" : order.status === "paying" ? "Check payment status" : `Approve ${total} USDC & pay`}</button>}
          </article>
        );
      })}
    </section>
  );
}
