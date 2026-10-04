import { reconcilePouch } from "../services/reconcile.js";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Pouch } from "@solpouch/shared";
import { fakeAddress } from "../store/memory.js";
import { publicPouch, type StoredPouch } from "../store/types.js";
import type { AuthEnv } from "../auth/session.js";
import { getOwnedPouch, HttpError, type Deps } from "../services/orders.js";

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
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) => { const rows = await deps.store.listPouches(c.get("user").email); return c.json(await Promise.all(rows.map(async p => publicPouch(await reconcilePouch(deps, p.id))))); });

  app.post("/", async (c) => {
    const email = c.get("user").email;
    const b = createBody.parse(await c.req.json());
    return deps.store.withPouchLock(`owner:${email}`,async()=> {
    if ((await deps.store.listPouches(email)).length >= 50) throw new HttpError(409, "Pouch limit reached (50)");
    const pouch: StoredPouch = {
      id: randomBytes(16).toString("hex"),
      address: fakeAddress(),
      name: b.name,
      balance: 0,
      maxPerOrder: b.maxPerOrder,
      dailyLimit: b.dailyLimit,
      spentToday: 0,
      confirmAbove: b.confirmAbove ?? 0,
      allowedMerchantIds: b.allowedMerchantIds,
      frozen: false,
      ownerEmail: email,
    };
    const { address } = await deps.vault.createPouch(pouch as Pouch);
    pouch.address = address;
    return c.json(publicPouch(await deps.store.savePouch(pouch)), 201);
    });
  });

  app.get("/:id", async (c) => { const p = await getOwnedPouch(deps, c.req.param("id"), c.get("user").email); return c.json(publicPouch(await reconcilePouch(deps,p.id))); });

  app.patch("/:id/rules", async (c) => {
    return deps.store.withPouchLock(c.req.param("id"),async()=> {
    const p = await getOwnedPouch(deps, c.req.param("id"), c.get("user").email);
    const b = updateBody.parse(await c.req.json());
    Object.assign(p, Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)));
    await deps.vault.updateRules(p);
    const fresh = await getOwnedPouch(deps, p.id, c.get("user").email);
    return c.json(publicPouch(await deps.store.savePouch({ ...fresh, ...Object.fromEntries(Object.entries(b).filter(([,v])=>v!==undefined)) })));
    });
  });

  // Same loop as the voice freeze_all tool, limited to the signed-in user's own pouches.
  app.post("/freeze-all", async (c) => {
    const email = c.get("user").email;
    const failed: string[] = [];
    for (const p of await deps.store.listPouches(email)) {
      if (p.frozen) continue;
      try { await deps.store.withPouchLock(p.id, () => deps.vault.freeze(p.id)); } catch (e) { console.error("freeze-all", p.id, e); failed.push(p.name); }
    }
    if (failed.length > 0) throw new HttpError(503, `Could not freeze: ${failed.join(", ")}`);
    const out: StoredPouch[] = [];
    for (const p of await deps.store.listPouches(email)) out.push(await reconcilePouch(deps, p.id).catch(() => p));
    return c.json(out.map(publicPouch));
  });

  app.post("/:id/freeze", async (c) => {
    return deps.store.withPouchLock(c.req.param("id"),async()=> {
    const email = c.get("user").email;
    const p = await getOwnedPouch(deps, c.req.param("id"), email);
    await deps.vault.freeze(p.id);
    return c.json(publicPouch(await getOwnedPouch(deps, p.id, email)));
    });
  });

  app.post("/:id/unfreeze", async (c) => {
    return deps.store.withPouchLock(c.req.param("id"),async()=> {
    const email = c.get("user").email;
    const p = await getOwnedPouch(deps, c.req.param("id"), email);
    await deps.vault.unfreeze(p.id);
    return c.json(publicPouch(await getOwnedPouch(deps, p.id, email)));
    });
  });

  return app;
}
