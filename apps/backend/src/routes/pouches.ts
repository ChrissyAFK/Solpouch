import { Hono } from "hono";
import { z } from "zod";
import type { Pouch } from "@solpouch/shared";
import { fakeAddress } from "../store/memory.js";
import { HttpError, type Deps } from "../services/orders.js";

const rules = {
  maxPerOrder: z.number().int().nonnegative().max(10_000_000_000),
  dailyLimit: z.number().int().nonnegative().max(10_000_000_000),
  confirmAbove: z.number().int().nonnegative().max(10_000_000_000),
  allowedMerchantIds: z.array(z.string().max(100)).max(100),
};
const createBody = z.object({
  name: z.string().min(1).max(60),
  maxPerOrder: rules.maxPerOrder,
  dailyLimit: rules.dailyLimit,
  confirmAbove: rules.confirmAbove.optional(),
  allowedMerchantIds: rules.allowedMerchantIds,
});
const updateBody = z.object({
  maxPerOrder: rules.maxPerOrder.optional(),
  dailyLimit: rules.dailyLimit.optional(),
  confirmAbove: rules.confirmAbove.optional(),
  allowedMerchantIds: rules.allowedMerchantIds.optional(),
});

export function pouchRoutes(deps: Deps) {
  const app = new Hono();
  const get = async (id: string) => {
    const p = await deps.store.getPouch(id);
    if (!p) throw new HttpError(404, "Pouch not found");
    return p;
  };

  app.get("/", async (c) => c.json(await deps.store.listPouches()));

  app.post("/", async (c) => {
    const b = createBody.parse(await c.req.json());
    if ((await deps.store.listPouches()).length >= 50) throw new HttpError(409, "Pouch limit reached (50)");
    const pouch: Pouch = {
      id: b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Date.now().toString(36),
      address: fakeAddress(),
      name: b.name,
      balance: 0,
      maxPerOrder: b.maxPerOrder,
      dailyLimit: b.dailyLimit,
      spentToday: 0,
      confirmAbove: b.confirmAbove ?? 0,
      allowedMerchantIds: b.allowedMerchantIds,
      frozen: false,
    };
    const { address } = await deps.vault.createPouch(pouch);
    pouch.address = address;
    return c.json(await deps.store.savePouch(pouch), 201);
  });

  app.get("/:id", async (c) => c.json(await get(c.req.param("id"))));

  app.patch("/:id/rules", async (c) => {
    const p = await get(c.req.param("id"));
    const b = updateBody.parse(await c.req.json());
    Object.assign(p, Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)));
    await deps.vault.updateRules(p);
    return c.json(await deps.store.savePouch(p));
  });

  app.post("/:id/freeze", async (c) => {
    const p = await get(c.req.param("id"));
    await deps.vault.freeze(p.id);
    return c.json(await get(p.id));
  });

  app.post("/:id/unfreeze", async (c) => {
    const p = await get(c.req.param("id"));
    await deps.vault.unfreeze(p.id);
    return c.json(await get(p.id));
  });

  return app;
}
