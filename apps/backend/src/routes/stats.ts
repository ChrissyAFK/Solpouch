import { Hono } from "hono";
import type { SpendPoint } from "@solpouch/shared";
import type { Deps } from "../services/orders.js";

// TODO: query the `spend_daily` continuous aggregate in Tiger Data once the Postgres store exists.
export function statsRoutes(deps: Deps) {
  const app = new Hono();
  app.get("/spend", async (c) => {
    const bucket = c.req.query("bucket") === "hour" ? "hour" : "day";
    const orders = (await deps.store.listOrders(c.req.query("pouchId"))).filter((o) => o.status === "paid");
    const points = new Map<string, SpendPoint>();
    for (const o of orders) {
      const d = new Date(o.createdAt);
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
