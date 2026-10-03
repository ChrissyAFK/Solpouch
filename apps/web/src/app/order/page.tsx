"use client";
import Link from "next/link";
import { StatePanel } from "@/components/StatePanel";
import { OrderSkeleton } from "@/components/Skeletons";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Merchant, Order, Pouch } from "@solpouch/shared";
import { toUsdc } from "@solpouch/shared";
import { api, ApiRequestError, errMsg } from "@/lib/api";
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

const suggestions = ["2 eggs and 1 bread", "1 oat milk", "10 deck screws"];

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

  const load = useCallback(async () => {
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
      setOrder(loadedOrder);
    } catch (e) {
      if (version === loadVersion.current) setLoadError(errMsg(e));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [query]);
  useEffect(() => {
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createOrder({
        request: request.trim(),
        pouchId: pouchId || undefined,
      });
      setOrder(created);
      window.history.replaceState(
        null,
        "",
        `/order?order=${encodeURIComponent(created.id)}`,
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function act(action: "confirm" | "cancel") {
    if (!order) return;
    setBusy(true);
    setError(null);
    try {
      setOrder(await api[action](order.id));
      setPouches(await api.pouches());
    } catch (e) {
      setError(errMsg(e));
      // A declined payment changes server state; show that result rather than a stale draft.
      try {
        setOrder(await api.order(order.id));
      } catch {
        /* retain the actionable error */
      }
    } finally {
      setBusy(false);
    }
  }
  const selected = pouches.find((p) => p.id === (order?.pouchId ?? pouchId));
  const isDraft = order?.status === "draft";
  const step = !order ? 1 : isDraft ? 2 : 3;
  const merchant = merchants.find((m) => m.id === order?.merchantId);

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/" className="text-sm text-[#a9a5b9] hover:underline">
        ← Back to overview
      </Link>
      <div className="mt-5 mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-[#f1edf8]">
          New order
        </h1>
        <p className="mt-3 text-[#a9a5b9]">
          Review items and pricing before payment.
        </p>
      </div>
      <ol
        aria-label="Order progress"
        className="mb-8 flex flex-wrap gap-5 text-sm"
      >
        {["Request", "Review", "Payment result"].map((name, i) => (
          <li
            key={name}
            aria-current={step === i + 1 ? "step" : undefined}
            className={`flex items-center gap-2 ${step === i + 1 ? "font-semibold text-[#f1edf8]" : "text-[#a9a5b9]"}`}
          >
            <span
              className={`flex h-7 w-7 items-center justify-center rounded text-xs ${step === i + 1 ? "bg-[#9945ff] text-white" : "bg-[#211d2d]"}`}
            >
              {i + 1}
            </span>
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
        <StatePanel title="Create a pouch first" home>
          Set up a pouch and add funds from the overview before placing your
          first order.
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
                  <label className={`${label} mb-3`} htmlFor="req">
                    Items to order
                  </label>
                  <textarea
                    id="req"
                    className={`${input} resize-y !p-4 !text-lg`}
                    rows={5}
                    required
                    value={request}
                    onChange={(e) => setRequest(e.target.value)}
                    placeholder="e.g. 2 eggs and 1 bread for the week"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {suggestions.map((text) => (
                      <button
                        type="button"
                        key={text}
                        onClick={() => setRequest(text)}
                        className="rounded border border-[#373041] bg-[#211d2d] px-3 py-2 text-xs text-[#f1edf8] hover:bg-[#34234b]"
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
                  <select
                    id="pouch"
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
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[#373041] pt-5">
                  <p className="max-w-64 text-xs leading-relaxed text-[#a9a5b9]">
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
                    <p className="text-xs uppercase tracking-wider text-[#a9a5b9]">
                      {merchant?.name ?? "Your order"}
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold">
                      {isDraft ? "Review order" : "Your order"}
                    </h2>
                  </div>
                  <span className="rounded bg-[#211d2d] px-3 py-1.5 text-xs font-semibold capitalize">
                    {order.status}
                  </span>
                </div>
                <p className="mt-3 text-sm text-[#a9a5b9]">“{order.request}”</p>
                {order.status === "paid" && (
                  <Notice>
                    {order.txSignature?.startsWith("mock")
                      ? "Payment complete."
                      : "Payment recorded."}
                  </Notice>
                )}
                {order.status === "rejected" && (
                  <ErrorBanner
                    message={`Your pouch declined this payment: ${order.rejectReason ?? "spending rule"}. No completed payment is recorded.`}
                  />
                )}
                {order.status === "cancelled" && (
                  <Notice>
                    Order cancelled. You haven’t paid for this cart.
                  </Notice>
                )}
                <div className="my-6 divide-y divide-[#373041]">
                  {order.lines.map((line, i) => (
                    <article key={i} className="py-5">
                      <div className="flex justify-between gap-4">
                        <div>
                          <h3 className="font-semibold">
                            {line.product?.name ?? "Item unavailable"}
                          </h3>
                          <p className="mt-1 text-sm text-[#a9a5b9]">
                            {line.product
                              ? [line.product.brand, line.product.size]
                                  .filter(Boolean)
                                  .join(" · ")
                              : line.requested}
                          </p>
                        </div>
                        <p className="shrink-0 font-semibold tabular-nums">
                          {line.product ? usd(toUsdc(line.lineTotal)) : "—"}
                        </p>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[#a9a5b9]">
                        <span>
                          Requested: {line.requestedQty} × {line.requested}
                        </span>
                        <span>
                          {line.qty} ×{" "}
                          {line.product
                            ? usd(toUsdc(line.product.unitPrice))
                            : "—"}{" "}
                          · {Math.round(line.matchScore * 100)}% match
                        </span>
                      </div>
                      {(line.substitution || line.note || !line.product) && (
                        <div
                          className={`mt-3 rounded px-3 py-2 text-sm ${line.substitution || !line.product ? "bg-[#342816] text-[#f4c879]" : "bg-[#211d2d] text-[#d2ccdc]"}`}
                        >
                          <strong>
                            {line.substitution
                              ? "Substitution · "
                              : !line.product
                                ? "Unavailable · "
                                : ""}
                          </strong>
                          {line.note ??
                            "Please check this item before approving."}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t border-[#373041] pt-5">
                  <span className="text-sm text-[#a9a5b9]">
                    Cart total · USDC
                  </span>
                  <strong className="text-3xl tracking-tight">
                    {usd(toUsdc(order.total))}
                  </strong>
                </div>
                <p className="mt-2 text-xs text-[#a9a5b9]">
                  Prices come from the store’s catalog.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  {isDraft ? (
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
                        setOrder(null);
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
                {order.txSignature && !order.txSignature.startsWith("mock") && (
                  <a
                    className="mt-4 inline-block text-sm underline"
                    target="_blank"
                    rel="noreferrer"
                    href={`https://explorer.solana.com/tx/${encodeURIComponent(order.txSignature)}?cluster=devnet`}
                  >
                    View transaction
                  </a>
                )}
              </section>
            )}
          </div>
          <aside className="space-y-5">
            {!selected && (
              <div className="border-t border-[#373041] pt-4">
                <h2 className="text-sm font-semibold">Available merchants</h2>
                <ul className="mt-3 divide-y divide-[#373041]">
                  {merchants.map((m) => (
                    <li key={m.id} className="py-3 text-sm text-[#a9a5b9]">
                      {m.name}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-xs text-[#a9a5b9]">
                  Approval required for every order.
                </p>
              </div>
            )}
            {selected && (
              <div className={card}>
                <p className="text-xs uppercase tracking-wider text-[#a9a5b9]">
                  Paying from
                </p>
                <h3 className="mt-3 font-semibold">{selected.name}</h3>
                <p className="mt-2 text-2xl font-semibold">
                  {usd(toUsdc(selected.balance))}
                </p>
                <p className="mt-1 text-xs text-[#a9a5b9]">Available balance</p>
                <div className="mt-4 border-t border-[#373041] pt-4 text-sm">
                  {usd(toUsdc(selected.maxPerOrder))} maximum per order
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
