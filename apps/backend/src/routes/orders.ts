import { Hono } from "hono";
import { z } from "zod";
import { cancelOrder, confirmOrder, createDraft, HttpError, type Deps } from "../services/orders.js";

const createBody = z.object({ request: z.string().min(1).max(1000), pouchId: z.string().max(100).optional() });

export function orderRoutes(deps: Deps) {
  const app = new Hono();

  app.post("/", async (c) => {
    const b = createBody.parse(await c.req.json());
    return c.json(await createDraft(deps, b.request, b.pouchId), 201);
  });

  app.get("/", async (c) => c.json(await deps.store.listOrders(c.req.query("pouchId"))));

  app.get("/:id", async (c) => {
    const o = await deps.store.getOrder(c.req.param("id"));
    if (!o) throw new HttpError(404, "Order not found");
    return c.json(o);
  });

  app.post("/:id/confirm", async (c) => c.json(await confirmOrder(deps, c.req.param("id"))));
  app.post("/:id/cancel", async (c) => c.json(await cancelOrder(deps, c.req.param("id"))));

  return app;
}
