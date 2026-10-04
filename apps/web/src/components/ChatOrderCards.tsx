"use client";
import { DemoCheckoutSummary } from "./DemoCheckoutSummary";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { isCheckoutReference, orderCurrency, toUsdc, type Order } from "@solpouch/shared";
import { api, errMsg } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useAuth } from "./AuthProvider";
import styles from "./ChatWidget.module.css";

/** Account-backed cards; never extract payment instructions from model text. */
export function ChatOrderCards({ refreshKey, live = false, onUpdate }: { refreshKey: number; live?: boolean; onUpdate?: (count: number, fresh: string | null) => void }) {
  const { sessionKey } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const freshCard = useRef<HTMLElement | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const report = useRef(onUpdate);
  useEffect(() => { report.current = onUpdate; });
  const current = () => mounted.current && getToken() === sessionKey;
  const load = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const result = await api.orders();
      if (!mounted.current || getToken() !== sessionKey || id !== sequence.current) return;
      setOrders(result.slice(0, 3));
      // Highlight a cart that appeared since the last load (e.g. one the voice agent just built).
      const newest = result[0];
      if (seen.current && newest && newest.status === "draft" && !seen.current.has(newest.id)) setFresh(newest.id);
      seen.current = new Set(result.map((o) => o.id));
      setUpdated(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setError(null);
    } catch (cause) {
      if (mounted.current && getToken() === sessionKey && id === sequence.current) setError(errMsg(cause));
    }
  }, [sessionKey]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => { if (sessionKey) void load(); }, [load, refreshKey, sessionKey]);
  // While a voice call is live, poll so a cart shows up as soon as the agent creates it.
  useEffect(() => {
    if (!live || !sessionKey) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [live, load, sessionKey]);
  useEffect(() => { report.current?.(orders.length, fresh); }, [orders.length, fresh]);
  useEffect(() => { if (fresh) freshCard.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [fresh]);
  async function confirm(order: Order, prepareDemo = false) {
    if (!current() || busy || (isCheckoutReference(order) && !prepareDemo)) return;
    setBusy(order.id);
    setError(null);
    try {
      const result = prepareDemo ? await api.prepareDemoCheckout(order.id, order.version ?? 0) : await api.confirm(order.id, order.version ?? 0);
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
        <span>{updated ? `Updated ${updated}` : "Your latest carts"}</span>
        <button type="button" disabled={!!busy} onClick={() => void load()}>Refresh carts</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {orders.length === 0 && <p className={styles.cardsEmpty}>No carts yet. Ask for something to buy, or use New order.</p>}
      {orders.map(order => {
        const reference = isCheckoutReference(order);
        const currency = `${orderCurrency(order)}${reference ? " estimate" : ""}`;
        const total = toUsdc(order.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return (
          <article key={order.id} ref={order.id === fresh ? freshCard : undefined} className={`${styles.orderCard} ${order.id === fresh ? styles.freshCard : ""}`}>
            {order.id === fresh && <span className={styles.freshBadge}>Just found</span>}
            <div className={styles.cardTop}>
              <strong>{order.store?.name ?? order.merchantId}</strong>
              <span className={styles.status}>{order.status === "paying" ? "Payment confirmation pending" : order.status}</span>
            </div>
            <ul>{order.lines.map((line, index) => <li key={index}>{line.qty} × {line.product?.name ?? line.requested}{line.product ? ` · $${toUsdc(line.lineTotal).toFixed(2)}` : ""}{line.substitution ? " · substitution" : ""}{line.note ? ` — ${line.note}` : ""}</li>)}</ul>
            <b>{total} {currency}</b>
            <DemoCheckoutSummary order={order} />
            {reference && order.status === "draft" && orderCurrency(order) === "CAD" && <button type="button" disabled={!!busy || order.total <= 0} onClick={() => void confirm(order, true)}>Prepare devnet demo checkout</button>}
            {reference && <p>Check the retailer’s price and complete checkout there. No retailer purchase is confirmed.</p>}
            <Link href={`/order?order=${encodeURIComponent(order.id)}`}>Review cart and receipt</Link>
            {reference && order.fulfillment?.checkoutUrl && /^https?:\/\//i.test(order.fulfillment.checkoutUrl) && <a href={order.fulfillment.checkoutUrl} target="_blank" rel="noopener noreferrer">Open retailer checkout ↗</a>}
            {!reference && (order.status === "draft" || order.status === "paying") && <button type="button" disabled={!!busy || order.total <= 0} onClick={() => void confirm(order)}>{busy === order.id ? "Checking…" : order.status === "paying" ? "Check payment status" : order.fulfillment?.via === "demo" ? `Pay demo checkout · ${toUsdc(order.total).toFixed(6)} test-USDC` : `Approve ${total} USDC & pay`}</button>}
          </article>
        );
      })}
    </section>
  );
}
