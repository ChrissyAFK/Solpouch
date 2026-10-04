import type { Order } from "@solpouch/shared";
import type { Store } from "../store/types.js";

/** Best-effort write of a paid order into the time-series tables. Never throws. */
export async function recordPaidOrder(store: Store, order: Order): Promise<void> {
  if (order.status !== "paid" || !order.txSignature || !order.paidAt || !Number.isFinite(Date.parse(order.paidAt))) return;
  try {
    await store.recordPayment({ time: order.paidAt, pouchId: order.pouchId, merchantId: order.merchantId, orderId: order.id, amount: order.total, txSignature: order.txSignature });
  } catch (e) {
    console.warn("payments metrics write failed:", (e as Error).message);
  }
  try {
    if (order.fulfillment?.via === "demo") return; // Converted test quotes are not retailer CAD prices.
    const time = order.paidAt;
    const seen = new Set<string>();
    const rows = [];
    for (const l of order.lines) {
      const p = l.product;
      if (!p || seen.has(`${p.merchantId}|${p.id}`)) continue;
      seen.add(`${p.merchantId}|${p.id}`);
      rows.push({ time, merchantId: p.merchantId, productId: p.id, unitPrice: p.unitPrice, inStock: p.inStock });
    }
    if (rows.length) await store.recordPrices(rows);
  } catch (e) {
    console.warn("prices metrics write failed:", (e as Error).message);
  }
}
