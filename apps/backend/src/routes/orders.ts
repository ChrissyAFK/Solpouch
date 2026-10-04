import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../auth/session.js";
import { cancelOrder, confirmOrder, createDraft, getOwnedOrder, listOwnedOrders, type Deps } from "../services/orders.js";

const createBody = z.object({ request: z.string().min(1).max(1000), pouchId: z.string().max(100).optional() });

export function orderRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();

  app.post("/", async (c) => {
    const b = createBody.parse(await c.req.json());
    return c.json(await createDraft(deps, c.get("user").email, b.request, b.pouchId), 201);
  });

  app.get("/", async (c) => c.json(await listOwnedOrders(deps, c.get("user").email, c.req.query("pouchId"))));

  app.get("/:id", async (c) => c.json(await getOwnedOrder(deps, c.req.param("id"), c.get("user").email)));

  app.post("/:id/confirm", async (c) => c.json(await confirmOrder(deps, c.get("user").email, c.req.param("id"))));
  app.post("/:id/cancel", async (c) => c.json(await cancelOrder(deps, c.get("user").email, c.req.param("id"))));

  return app;
}
