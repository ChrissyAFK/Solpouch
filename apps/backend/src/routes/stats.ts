import { requestDeps } from "../security/access.js";
import { z } from "zod";
import { Hono } from "hono";
import type { SpendPoint } from "@solpouch/shared";
import type { Deps } from "../services/orders.js";

export function statsRoutes(_baseDeps: Deps) {
  const app = new Hono();
  app.get("/spend", async (c) => {
    const bucket = z.enum(["hour", "day"]).parse(c.req.query("bucket") ?? "day");
    const orders = (await requestDeps(c).store.listOrders(c.req.query("pouchId"))).filter((o) => o.status === "paid");
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
