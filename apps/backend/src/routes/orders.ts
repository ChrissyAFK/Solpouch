import { editDraft, editDraftBody } from "../services/shopping.js";
import { createInstacartList, trustedInstacartUrl } from "../services/instacart.js";
import { HttpError } from "../services/orders.js";
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

  app.post("/:id/instacart", async (c) => {
    const email = c.get("user").email;
    const initial = await getOwnedOrder(deps, c.req.param("id"), email);
    const order = await deps.store.withPouchLock(initial.pouchId, async () => {
      const order = await getOwnedOrder(deps, initial.id, email);
      if (order.status !== "draft") throw new HttpError(409, "Only an unpaid draft can be sent to Instacart.");
      const saved = order.fulfillment;
      if (saved?.via === "instacart" && saved.linkStatus === "ready" && trustedInstacartUrl(saved.checkoutUrl) && Date.parse(saved.linkExpiresAt ?? "") > Date.now()) return order;
      const lines = order.lines.filter(line => line.product && line.qty > 0).map(line => ({ name: line.product!.name, quantity: line.qty }));
      const link = await createInstacartList("Your Solpouch shopping list", lines);
      return deps.store.saveOrder({ ...order, fulfillment: { via: "instacart", label: "Instacart shopping list", ...link } });
    });
    return c.json(order);
  });

  app.patch("/:id", async c => c.json(await editDraft(deps,c.get("user").email,c.req.param("id"),editDraftBody.parse(await c.req.json()))));
  app.post("/:id/confirm", async (c) => {
    const text = await c.req.text();
    const b = z.object({version:z.number().int().positive().optional()}).strict().parse(text ? JSON.parse(text) : {});
    return c.json(await confirmOrder(deps, c.get("user").email, c.req.param("id"), b.version ?? -1));
  });
  app.post("/:id/cancel", async (c) => c.json(await cancelOrder(deps, c.get("user").email, c.req.param("id"))));

  return app;
}
