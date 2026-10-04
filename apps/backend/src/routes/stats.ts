import { Hono } from "hono";
import type { Order, SpendPoint } from "@solpouch/shared";
import type { AuthEnv } from "../auth/session.js";
import { getOwnedPouch, listOwnedOrders, type Deps } from "../services/orders.js";
import { isPaymentIndex, spendBucket } from "../store/types.js";

// Indexed on-chain payments (the payments table, written by src/indexer.ts) plus paid orders
// the indexer has not reached yet (matched by orderId = orders.id), so indexer lag never hides spend.
// With no payment index, spend comes from paid orders alone.
export function statsRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();
  app.get("/spend", async (c) => {
    const bucket = c.req.query("bucket") === "hour" ? "hour" : "day";
    const email = c.get("user").email;
    const pouchId = c.req.query("pouchId");
    let orders: Order[] = (await listOwnedOrders(deps, email, pouchId)).filter((o) => o.status === "paid" && o.paidAt && Number.isFinite(Date.parse(o.paidAt)));
    const points = new Map<string, SpendPoint>();
    const add = (pouch: string, b: string, spent: number, count: number) => {
      const key = `${pouch}|${b}`;
      const pt = points.get(key) ?? { bucket: b, pouchId: pouch, spent: 0, orders: 0 };
      pt.spent += spent;
      pt.orders += count;
      points.set(key, pt);
    };
    if (isPaymentIndex(deps.store)) {
      const ids = pouchId ? [(await getOwnedPouch(deps, pouchId, email)).id] : (await deps.store.listPouches(email)).map((p) => p.id);
      const indexed = (await deps.store.indexedSpend(ids, bucket)) ?? [];
      for (const pt of indexed) add(pt.pouchId, pt.bucket, pt.spent, pt.orders);
      if (indexed.length && orders.length) {
        const seen = await deps.store.indexedOrderIds(ids, orders.map((o) => o.id));
        orders = orders.filter((o) => !seen.has(o.id.toLowerCase()));
      }
    }
    for (const o of orders) add(o.pouchId, spendBucket(o.paidAt!, bucket), o.total, 1);
    return c.json([...points.values()].sort((a, b) => a.bucket.localeCompare(b.bucket) || a.pouchId.localeCompare(b.pouchId)));
  });
  return app;
}
