import { requestDeps } from "../security/access.js";
import { z } from "zod";
import { Hono } from "hono";
import type { SpendPoint } from "@solpouch/shared";
import { HttpError, type Deps } from "../services/orders.js";

export function statsRoutes(_baseDeps: Deps) {
  const app = new Hono();
  app.get("/spend", async (c) => {
    const bucket = z.enum(["hour", "day"]).parse(c.req.query("bucket") ?? "day");
    const store = requestDeps(c).store;
    const pouchId = c.req.query("pouchId");
    // The request store only lists the signed-in owner's pouches, so this is the owner scope.
    const owned = (await store.listPouches()).map((p) => p.id);
    if (pouchId && !owned.includes(pouchId)) throw new HttpError(404, "Pouch not found");
    // A failing time-series query must not take the chart down: fall through to the orders-based numbers.
    const series = await store.spendSeries(pouchId ? [pouchId] : owned, bucket, new Date(0).toISOString()).catch((e) => {
      console.warn(`[stats] spendSeries failed: ${e instanceof Error ? e.message : e}`);
      return [] as SpendPoint[];
    });
    if (series.length) return c.json(series);
    // Time-series table not backfilled yet: compute from paid orders.
    const orders = (await store.listOrders(pouchId)).filter((o) => o.status === "paid");
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
