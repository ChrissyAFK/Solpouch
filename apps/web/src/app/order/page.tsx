"use client";
import Link from "next/link";
import { StatePanel } from "@/components/StatePanel";
import { OrderSkeleton } from "@/components/Skeletons";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Merchant, Order, Pouch } from "@solpouch/shared";
import { toUsdc } from "@solpouch/shared";
import { api, ApiRequestError, errMsg } from "@/lib/api";
import { useLiveRefresh } from "@/lib/useLiveRefresh";
import { PouchGlyph } from "@/components/PouchGlyph";
import s from "./order.module.css";
import {
  ErrorBanner,
  Notice,
  btnPrimary,
  btnSecondary,
  card,
  input,
  label,
  usd,
} from "@/components/ui";

function ItemName({
  product,
  fallback,
  paper,
}: {
  product: Order["lines"][number]["product"];
  fallback: string;
  paper?: boolean;
}) {
  const name = product?.name ?? fallback;
  return (
    <>
      {product?.url ? (
        <a
          href={product.url}
          target="_blank"
          rel="noopener noreferrer"
          className={s.itemLink}
        >
          {name}
        </a>
      ) : (
        name
      )}
      {product?.estimated && (
        <span className={paper ? s.estimatedPaper : s.estimated}>
          Estimated price
        </span>
      )}
    </>
  );
}

function StoreVia({ order, paper }: { order: Order; paper?: boolean }) {
  const { store, fulfillment: f } = order;
  if (!store && !(f && f.via !== "direct")) return null;
  const via =
    f?.via === "instacart"
      ? "Bought via Instacart"
      : f?.via === "service"
        ? "Bought via Solpouch Buyer"
        : null;
  const linkText = f?.via === "instacart" ? "Open Instacart cart" : "Open store page";
  return (
    <div className={paper ? s.viaPaper : s.via}>
      {store?.url && (
        <div>
          <a
            href={store.url}
            target="_blank"
            rel="noopener noreferrer"
            className={s.itemLink}
          >
            {store.domain}
          </a>
        </div>
      )}
      {!store?.url && store?.domain && <div>{store.domain}</div>}
      {via && <div>{via}</div>}
      {f?.checkoutUrl && (
        <a
          href={f.checkoutUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={s.viaButton}
        >
          {linkText}
        </a>
      )}
    </div>
  );
}

const suggestions =["2 eggs and 1 bread", "1 oat milk", "10 deck screws"];

export default function OrderPage() {
  return (
    <Suspense fallback={<OrderSkeleton heading />}>
      <OrderWorkspace />
    </Suspense>
  );
}

function OrderWorkspace() {
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const [pouches, setPouches] = useState<Pouch[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [request, setRequest] = useState("");
  const [pouchId, setPouchId] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missingOrder, setMissingOrder] = useState(false);
  const loadVersion = useRef(0);
  // Mirrors of state so the URL-driven load and the live refresh can see what is on screen.
  const orderRef = useRef<Order | null>(null);
  const loadedOnce = useRef(false);
  const busyRef = useRef(false);
  const requestRef = useRef("");
  const loadingRef = useRef(true);
  const openedAt = useRef(Date.now());
  const showOrder = useCallback((next: Order | null) => {
    orderRef.current = next;
    setOrder(next);
  }, []);
  useEffect(() => {
    requestRef.current = request;
    loadingRef.current = loading;
  }, [request, loading]);

  const load = useCallback(async () => {
    // The URL only changed because this page replaced it for the order already shown: no reload.
    const urlId = new URLSearchParams(query).get("order");
    if (loadedOnce.current) {
      if (urlId && urlId === orderRef.current?.id) return;
      if (!urlId && query === "" && !orderRef.current) return;
    }
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadError(null);
    setMissingOrder(false);
    setError(null);
    try {
      const params = new URLSearchParams(query);
      const orderId = params.get("order");
      let loadedOrder: Order | null = null;
      if (orderId) {
        try {
          loadedOrder = await api.order(orderId);
        } catch (e) {
          if (
            version === loadVersion.current &&
            e instanceof ApiRequestError &&
            e.status === 404
          )
            setMissingOrder(true);
          throw e;
        }
      }
      const [p, m] = await Promise.all([api.pouches(), api.merchants()]);
      if (version !== loadVersion.current) return;
      setPouches(p);
      setMerchants(m);
      const initialPouch = params.get("pouch");
      setPouchId(
        initialPouch && p.some((item) => item.id === initialPouch)
          ? initialPouch
          : "",
      );
      setRequest(params.get("request") ?? "");
      showOrder(loadedOrder);
      loadedOnce.current = true;
    } catch (e) {
      if (version === loadVersion.current) setLoadError(errMsg(e));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [query, showOrder]);
  useEffect(() => {
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [load]);

  // Quiet refresh: follows the shown order's status, or picks up a voice-created draft.
  const liveRefresh = useCallback(async () => {
    if (busyRef.current || loadingRef.current || !loadedOnce.current) return;
    const current = orderRef.current;
    try {
      if (current) {
        if (!["draft", "confirmed", "paying"].includes(current.status)) return;
        const latest = await api.order(current.id);
        if (busyRef.current || orderRef.current?.id !== current.id) return;
        if (latest.status === current.status) return;
        showOrder(latest);
        if (latest.status === "paid" || latest.status === "rejected")
          void api.pouches().then(setPouches).catch(() => {});
        return;
      }
      if (requestRef.current.trim()) return;
      const all = await api.orders();
      if (busyRef.current || orderRef.current || requestRef.current.trim()) return;
      const fresh = all
        .filter(
          (o) =>
            o.status === "draft" && new Date(o.createdAt).getTime() > openedAt.current,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!fresh) return;
      showOrder(fresh);
      window.history.replaceState(
        null,
        "",
        `/order?order=${encodeURIComponent(fresh.id)}`,
      );
    } catch {
      /* background refresh stays silent */
    }
  }, [showOrder]);
  useLiveRefresh(liveRefresh);

  // Chat handoff (?request=): with one usable pouch, run the lookup once per request value.
  // It only builds a draft cart; approving and paying stay a manual click.
  const handoff = searchParams.get("request")?.trim() ?? "";
  const autoRan = useRef<string | null>(null);
  const focusedFor = useRef<string | null>(null);
  const pouchSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (loading || loadError || !loadedOnce.current || orderRef.current) return;
    if (!handoff || !merchants.length || busyRef.current) return;
    const usable = pouches.filter((p) => !p.frozen);
    // A link that names a different pouch (e.g. a frozen one) is the user's call, not ours.
    const named = new URLSearchParams(window.location.search).get("pouch");
    if (usable.length === 1 && (!named || named === usable[0].id)) {
      if (autoRan.current === handoff) return;
      autoRan.current = handoff;
      setPouchId(usable[0].id);
      void createDraft(handoff, usable[0].id);
    } else if (focusedFor.current !== handoff) {
      focusedFor.current = handoff;
      pouchSelect.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loadError, handoff, pouches, merchants]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await createDraft(request.trim(), pouchId || undefined);
  }
  async function createDraft(text: string, pid: string | undefined) {
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      const created = await api.createOrder({
        request: text,
        pouchId: pid,
      });
      showOrder(created);
      window.history.replaceState(
        null,
        "",
        `/order?order=${encodeURIComponent(created.id)}`,
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function act(action: "confirm" | "cancel") {
    if (!order) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      showOrder(await api[action](order.id));
      try {
        setPouches(await api.pouches());
      } catch {
        /* the receipt is already final; a failed balance refresh is not an error here */
      }
    } catch (e) {
      setError(errMsg(e));
      // A declined payment changes server state; show that result rather than a stale draft.
      try {
        showOrder(await api.order(order.id));
      } catch {
        /* retain the actionable error */
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const selected = pouches.find((p) => p.id === (order?.pouchId ?? pouchId));
  const isDraft = order?.status === "draft";
  const isPaying = order?.status === "paying";
  const step = !order ? 1 : isDraft || isPaying ? 2 : 3;
  const merchant = merchants.find((m) => m.id === order?.merchantId);
  const paidDate = new Date(order?.createdAt ?? Date.now()).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/dashboard" className="text-sm text-[var(--muted)] hover:underline">
        ← Back to overview
      </Link>
      <div className="mt-5 mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--ink)]">
          New order
        </h1>
        <p className="mt-3 text-[var(--muted)]">
          Review items and pricing before payment.
        </p>
      </div>
      <ol aria-label="Order progress" className={s.steps}>
        {["Request", "Review", "Payment result"].map((name, i) => (
          <li
            key={name}
            aria-current={step === i + 1 ? "step" : undefined}
            className={step === i + 1 ? s.stepCurrent : undefined}
          >
            {name}
          </li>
        ))}
      </ol>
      <ErrorBanner message={error} />
      {loading ? (
        <OrderSkeleton />
      ) : loadError ? (
        <StatePanel
          title={missingOrder ? "Order not found" : "Ordering is unavailable"}
          retry={missingOrder ? undefined : () => void load()}
          home
          newOrder={missingOrder}
        >
          {missingOrder
            ? "This order is no longer available."
            : "We couldn’t load your order, pouches, or merchants. Try again before building a cart."}
        </StatePanel>
      ) : !order && !pouches.length ? (
        <StatePanel
          title="Create a pouch first"
          home
          action={{ href: "/pouches", label: "Create a pouch" }}
        >
          Set up a pouch and add funds before placing your first order.
        </StatePanel>
      ) : !order && !merchants.length ? (
        <StatePanel
          title="No merchants available"
          retry={() => void load()}
          home
        >
          Shopping is unavailable until a merchant catalog is connected.
        </StatePanel>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_290px]">
          <div className="min-w-0">
            {!order ? (
              <form onSubmit={submit} className={`${card} space-y-6`}>
                <div>
                  <div className={s.talkRow}>
                    <button
                      type="button"
                      className={`${btnSecondary} ${s.talk}`}
                      onClick={() =>
                        window.dispatchEvent(new CustomEvent("solpouch:talk"))
                      }
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="9" y="3" width="6" height="11" rx="3" />
                        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                      </svg>
                      Talk to Solpouch
                    </button>
                  </div>
                  <label className={s.orType} htmlFor="req">
                    Or type it
                  </label>
                  <textarea
                    id="req"
                    className={`${input} resize-y !p-4 !text-lg`}
                    rows={5}
                    required
                    value={request}
                    onChange={(e) => setRequest(e.target.value)}
                    placeholder="2 dozen eggs and oat milk, or a chainsaw for the cabin"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {suggestions.map((text) => (
                      <button
                        type="button"
                        key={text}
                        onClick={() => setRequest(text)}
                        className={s.chip}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className={label} htmlFor="pouch">
                    Choose a pouch
                  </label>
                  <div className={s.pouchPick}>
                    {selected && (
                      <PouchGlyph
                        name={selected.name}
                        remaining={toUsdc(
                          Math.max(0, selected.dailyLimit - selected.spentToday),
                        )}
                        limit={toUsdc(selected.dailyLimit)}
                        size="sm"
                        frozen={selected.frozen}
                      />
                    )}
                    <select
                      id="pouch"
                      ref={pouchSelect}
                      className={input}
                      value={pouchId}
                      onChange={(e) => setPouchId(e.target.value)}
                    >
                      <option value="">Select automatically</option>
                      {pouches.map((p) => (
                        <option key={p.id} value={p.id} disabled={p.frozen}>
                          {p.name} · {usd(toUsdc(p.balance))}
                          {p.frozen ? " · Frozen" : ""}
                        </option>
                      ))}
                    </select>
                    {selected && (
                      <span className={`${s.pouchLeft} num`}>
                        {usd(
                          toUsdc(
                            Math.max(0, selected.dailyLimit - selected.spentToday),
                          ),
                        )}{" "}
                        left today
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--line-strong)] pt-5">
                  <p className="max-w-64 text-xs leading-relaxed text-[var(--muted)]">
                    No payment until you approve the order.
                  </p>
                  <button
                    className={btnPrimary}
                    disabled={busy || !request.trim() || !pouches.length}
                    type="submit"
                  >
                    {busy ? "Finding items…" : "Find items"}
                  </button>
                </div>
              </form>
            ) : (
              <section className={card}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-2xl font-semibold">
                      {isDraft ? "Review order" : "Your order"}
                    </h2>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      {order.store?.name ?? merchant?.name ?? "Your order"}
                    </p>
                    {order.status !== "paid" && <StoreVia order={order} />}
                  </div>
                  <span className={s.statusPill}>{order.status}</span>
                </div>
                <p className="mt-3 text-sm text-[var(--muted)]">“{order.request}”</p>
                {isPaying && (
                  <div className={s.checkBox} role="status">
                    <strong>Checking payment · </strong>
                    Payment is still being checked. Use “Check payment status” to recover its result. Do not start another order for the same purchase.
                  </div>
                )}
                {order.status === "paid" && (
                  <div className={s.receipt} aria-label="Receipt">
                    <span className={s.stamp}>Paid</span>
                    <div className={s.receiptHead}>
                      <div className={s.receiptStore}>
                        {order.store?.name ?? merchant?.name ?? "Your order"}
                      </div>
                      <StoreVia order={order} paper />
                      <div className={s.receiptMeta}>{paidDate}</div>
                    </div>
                    <ul className={s.receiptItems}>
                      {order.lines.map((line, i) => (
                        <li key={i} className={s.receiptItem}>
                          <span>
                            <ItemName product={line.product} fallback={line.requested} paper />
                            <br />
                            <span className={s.receiptQty}>
                              {line.qty} ×{" "}
                              {line.product
                                ? usd(toUsdc(line.product.unitPrice))
                                : "—"}
                            </span>
                          </span>
                          <span className="num">
                            {line.product ? usd(toUsdc(line.lineTotal)) : "—"}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className={s.receiptTotal}>
                      <span>Total</span>
                      <span className="num">{usd(toUsdc(order.total))}</span>
                    </div>
                    {selected && (
                      <div className={s.receiptBalances}>
                        <div>
                          <span>{selected.name} balance</span>
                          <b className="num">{usd(toUsdc(selected.balance))}</b>
                        </div>
                        <div>
                          <span>Left today</span>
                          <b className="num">
                            {usd(
                              toUsdc(
                                Math.max(
                                  0,
                                  selected.dailyLimit - selected.spentToday,
                                ),
                              ),
                            )}
                          </b>
                        </div>
                      </div>
                    )}
                    <div className={s.receiptFoot}>
                      {order.txSignature &&
                      !order.txSignature.startsWith("mock") ? (
                        <a
                          target="_blank"
                          rel="noopener noreferrer"
                          href={`https://explorer.solana.com/tx/${encodeURIComponent(order.txSignature)}?cluster=devnet`}
                        >
                          View on Solana Explorer
                        </a>
                      ) : (
                        <span>Demo payment</span>
                      )}
                      <Link href="/orders">View all orders</Link>
                      <Link href={`/pouches/${encodeURIComponent(order.pouchId)}`}>
                        Open pouch
                      </Link>
                    </div>
                  </div>
                )}
                {order.status === "rejected" && (
                  <div role="alert" className={s.rejected}>
                    Your pouch declined this payment:{" "}
                    {order.rejectReason ?? "spending rule"}. No completed
                    payment is recorded.
                  </div>
                )}
                {order.status === "cancelled" && (
                  <Notice>
                    Order cancelled. You haven’t paid for this cart.
                  </Notice>
                )}
                {order.status !== "paid" && (
                <>
                <div className={s.lines}>
                  {order.lines.map((line, i) => {
                    const exact =
                      !!line.product &&
                      !line.substitution &&
                      line.matchScore >= 0.9;
                    return (
                      <article key={i} className={s.line}>
                        <div className="flex justify-between gap-4">
                          <div>
                            <h3 className="font-semibold">
                              <ItemName product={line.product} fallback="Item unavailable" />
                            </h3>
                            <p className="mt-1 text-sm text-[var(--muted)]">
                              {line.product
                                ? [line.product.brand, line.product.size]
                                    .filter(Boolean)
                                    .join(" · ")
                                : line.requested}
                            </p>
                          </div>
                          <p className="num shrink-0 font-semibold">
                            {line.product ? usd(toUsdc(line.lineTotal)) : "—"}
                          </p>
                        </div>
                        <div className={`mt-3 flex flex-wrap items-center justify-between gap-2 ${s.secondary}`}>
                          <span>
                            Requested: <span className="num">{line.requestedQty}</span> × {line.requested}
                          </span>
                          <span className="num">
                            {line.qty} ×{" "}
                            {line.product
                              ? usd(toUsdc(line.product.unitPrice))
                              : "—"}
                          </span>
                        </div>
                        {exact ? (
                          <span className={`${s.state} ${s.exact}`}>
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M3 8.5l3.2 3L13 4.5" />
                            </svg>
                            Exact
                          </span>
                        ) : (
                          <div className={s.checkBox}>
                            <strong>
                              {!line.product
                                ? "Unavailable · "
                                : line.substitution
                                  ? "Check this · Substitution · "
                                  : "Check this · "}
                            </strong>
                            {line.note ??
                              "Please check this item before approving."}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between border-t border-[var(--line-strong)] pt-5">
                  <span className="text-sm text-[var(--muted)]">
                    Cart total · USDC
                  </span>
                  <strong className="num text-3xl tracking-tight">
                    {usd(toUsdc(order.total))}
                  </strong>
                </div>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  Prices come from the store’s catalog.
                </p>
                </>
                )}
                <div className="mt-6 flex flex-wrap gap-3">
                  {isPaying ? (
                    <button className={btnPrimary} disabled={busy} onClick={() => void act("confirm")}>
                      {busy ? "Checking payment…" : "Check payment status"}
                    </button>
                  ) : isDraft ? (
                    <>
                      <button
                        className={btnPrimary}
                        disabled={busy || order.total <= 0}
                        onClick={() => void act("confirm")}
                      >
                        {busy
                          ? "Processing…"
                          : `Approve ${usd(toUsdc(order.total))} & pay`}
                      </button>
                      <button
                        className={btnSecondary}
                        disabled={busy}
                        onClick={() => void act("cancel")}
                      >
                        Cancel order
                      </button>
                    </>
                  ) : (
                    <button
                      className={btnPrimary}
                      onClick={() => {
                        showOrder(null);
                        setError(null);
                        window.history.replaceState(null, "", "/order");
                        void api
                          .pouches()
                          .then(setPouches)
                          .catch((e) => setError(errMsg(e)));
                      }}
                    >
                      New order
                    </button>
                  )}
                </div>
              </section>
            )}
          </div>
          <aside className="space-y-5">
            {!selected && (
              <div className="border-t border-[var(--line-strong)] pt-4">
                <h2 className="text-sm font-semibold">Available merchants</h2>
                <ul className="mt-3 divide-y divide-[var(--line-strong)]">
                  {merchants.map((m) => (
                    <li key={m.id} className="py-3 text-sm text-[var(--muted)]">
                      {m.name}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-[var(--muted)]">
                  These are examples. Anything else is searched online when the
                  pouch allows any store.
                </p>
                <p className="mt-3 text-xs text-[var(--muted)]">
                  Approval required for every order.
                </p>
              </div>
            )}
            {selected && (
              <div className={card}>
                <p className="text-sm text-[var(--muted)]">
                  Paying from
                </p>
                <h3 className="mt-3 font-semibold">{selected.name}</h3>
                <p className="num mt-2 text-2xl font-semibold">
                  {usd(toUsdc(selected.balance))}
                </p>
                <p className="mt-1 text-xs text-[var(--muted)]">Available balance</p>
                <div className="mt-4 border-t border-[var(--line-strong)] pt-4 text-sm">
                  <span className="num">{usd(toUsdc(selected.maxPerOrder))}</span> maximum per order
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
