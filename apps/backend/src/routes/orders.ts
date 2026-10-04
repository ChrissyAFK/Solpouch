import { requestDeps } from "../security/access.js";
import { Hono } from "hono";
import { z } from "zod";
import { cancelOrder, confirmOrder, createDraft, HttpError, type Deps } from "../services/orders.js";

const createBody = z.object({ request: z.string().trim().min(1).max(1000), pouchId: z.string().min(1).max(100).optional() }).strict();

export function orderRoutes(_baseDeps: Deps) {
  const app = new Hono();

  app.post("/", async (c) => {
    const b = createBody.parse(await c.req.json());
    return c.json(await createDraft(requestDeps(c), b.request, b.pouchId), 201);
  });

  app.get("/", async (c) => c.json(await requestDeps(c).store.listOrders(c.req.query("pouchId"))));

  app.get("/:id", async (c) => {
    const o = await requestDeps(c).store.getOrder(c.req.param("id"));
    if (!o) throw new HttpError(404, "Order not found");
    return c.json(o);
  });

  app.post("/:id/confirm", async (c) => c.json(await confirmOrder(requestDeps(c), c.req.param("id"))));
  app.post("/:id/cancel", async (c) => c.json(await cancelOrder(requestDeps(c), c.req.param("id"))));

  return app;
}
