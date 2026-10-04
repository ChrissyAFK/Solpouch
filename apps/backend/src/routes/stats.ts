import { Hono } from "hono";
import type { SpendPoint } from "@solpouch/shared";
import type { AuthEnv } from "../auth/session.js";
import { getOwnedPouch, listOwnedOrders, type Deps } from "../services/orders.js";
import { isPaymentIndex } from "../store/types.js";

// Prefer indexed on-chain payments (spend_daily / payments, written by src/indexer.ts);
// fall back to summing paid orders when nothing is indexed for this account's pouches.
export function statsRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();
  app.get("/spend", async (c) => {
    const bucket = c.req.query("bucket") === "hour" ? "hour" : "day";
    const email = c.get("user").email;
    const pouchId = c.req.query("pouchId");
    if (isPaymentIndex(deps.store)) {
      const ids = pouchId ? [(await getOwnedPouch(deps, pouchId, email)).id] : (await deps.store.listPouches(email)).map((p) => p.id);
      const indexed = await deps.store.indexedSpend(ids, bucket);
      if (indexed) return c.json(indexed);
    }
    const orders = (await listOwnedOrders(deps, email, pouchId)).filter((o) => o.status === "paid" && o.paidAt && Number.isFinite(Date.parse(o.paidAt)));
    const points = new Map<string, SpendPoint>();
    for (const o of orders) {
      const d = new Date(o.paidAt!);
      if (bucket === "day") d.setUTCHours(0, 0, 0, 0);
      else d.setUTCMinutes(0, 0, 0);
      const key = `${o.pouchId}|${d.toISOString()}`;
      const pt = points.get(key) ?? { bucket: d.toISOString(), pouchId: o.pouchId, spent: 0, orders: 0 };
      pt.spent += o.total;
      pt.orders += 1;
      points.set(key, pt);
    }
    return c.json([...points.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)));
  });
  return app;
}
