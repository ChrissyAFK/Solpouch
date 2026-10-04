import { reconcilePouch } from "../services/reconcile.js";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Pouch } from "@solpouch/shared";
import { fakeAddress } from "../store/memory.js";
import { getMerchant } from "../merchants/index.js";
import { requestDeps } from "../security/access.js";
import { HttpError, type Deps } from "../services/orders.js";

const rules = {
  maxPerOrder: z.number().int().nonnegative().max(10_000_000_000),
  dailyLimit: z.number().int().nonnegative().max(10_000_000_000),
  confirmAbove: z.number().int().nonnegative().max(10_000_000_000),
  // Match the vault program's MAX_MERCHANTS and reject unknown destinations.
  allowedMerchantIds: z.array(z.string().min(1).max(100).refine((id) => !!getMerchant(id), "Unknown merchant"))
    .max(10).refine((ids) => new Set(ids).size === ids.length, "Choose each merchant only once"),
};
const createBody = z.object({
  name: z.string().trim().min(1).max(60),
  maxPerOrder: rules.maxPerOrder,
  dailyLimit: rules.dailyLimit,
  confirmAbove: rules.confirmAbove.optional(),
  allowedMerchantIds: rules.allowedMerchantIds,
}).strict();
const updateBody = z.object({
  maxPerOrder: rules.maxPerOrder.optional(),
  dailyLimit: rules.dailyLimit.optional(),
  confirmAbove: rules.confirmAbove.optional(),
  allowedMerchantIds: rules.allowedMerchantIds.optional(),
}).strict().refine((body) => Object.values(body).some((value) => value !== undefined), "Provide a rule to update");

async function get(deps: Deps, id: string) {
  const pouch = await deps.store.getPouch(id);
  if (!pouch) throw new HttpError(404, "Pouch not found");
  return pouch;
}

export function pouchRoutes(_baseDeps: Deps) {
  const app = new Hono();
  app.get("/", async (c) => {
    const deps = requestDeps(c); const pouches = await deps.store.listPouches();
    const current = []; for (const pouch of pouches) current.push(await reconcilePouch(deps, pouch.id));
    return c.json(current);
  });
  app.post("/", async (c) => {
    const deps = requestDeps(c);
    const ownerWallet = c.get("wallet") as string;
    const body = createBody.parse(await c.req.json());
    return deps.store.withPouchLock(`owner:${ownerWallet}`, async () => {
      if ((await deps.store.listPouches()).length >= 50) throw new HttpError(409, "Pouch limit reached (50)");
      const pouch: Pouch = {
        id: randomBytes(16).toString("hex"),
        ownerWallet,
        address: fakeAddress(),
        name: body.name,
        balance: 0,
        maxPerOrder: body.maxPerOrder,
        dailyLimit: body.dailyLimit,
        spentToday: 0,
        confirmAbove: body.confirmAbove ?? 0,
        allowedMerchantIds: body.allowedMerchantIds,
        frozen: false,
      };
      const { address } = await deps.vault.createPouch(pouch);
      pouch.address = address;
      return c.json(await deps.store.savePouch(pouch), 201);
    });
  });
  app.get("/:id", async (c) => c.json(await reconcilePouch(requestDeps(c), c.req.param("id"))));
  app.patch("/:id/rules", async (c) => {
    const deps = requestDeps(c);
    const id = c.req.param("id");
    const body = updateBody.parse(await c.req.json());
    const updates = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
    await get(deps, id);
    return deps.store.withPouchLock(id, async () => {
      const pouch = await get(deps, id);
      await deps.vault.updateRules({ ...pouch, ...updates });
      // The vault adapter may have saved a refreshed balance/version while applying rules.
      const latest = await get(deps, id);
      return c.json(await deps.store.savePouch({ ...latest, ...updates }));
    });
  });
  for (const action of ["freeze", "unfreeze"] as const) {
    app.post(`/:id/${action}`, async (c) => {
      const deps = requestDeps(c);
      const id = c.req.param("id");
      await get(deps, id);
      return deps.store.withPouchLock(id, async () => {
        await get(deps, id);
        await deps.vault[action](id);
        return c.json(await get(deps, id));
      });
    });
  }
  return app;
}
