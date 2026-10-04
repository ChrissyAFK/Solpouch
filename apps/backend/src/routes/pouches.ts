import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { MAX_ALLOWED_MERCHANTS, pouchRuleError, type Pouch } from "@solpouch/shared";
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
const RULE_MESSAGES = {
  TooManyMerchants: `A pouch can allow at most ${MAX_ALLOWED_MERCHANTS} stores. Remove some stores, or choose Any store.`,
  ZeroLimit: "Limits must be more than zero.",
  PerOrderOverDaily: "The limit per order cannot be higher than the daily limit.",
  DuplicateMerchant: "Each store can only be added to a pouch once.",
} as const;
/**
 * Checked outside zod so the response is a 422 with the vault program's error code, not a generic 400.
 * Always pass the full rules a pouch will have (for PATCH, existing values merged with the patch).
 */
function assertRules(r: Pick<Pouch, "maxPerOrder" | "dailyLimit" | "allowedMerchantIds">) {
  const code = pouchRuleError(r);
  if (code) throw new HttpError(422, RULE_MESSAGES[code], code);
}
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

  app.get("/", async (c) => c.json((await deps.store.listPouches(c.get("user").email)).map(publicPouch)));

  app.post("/", async (c) => {
    const email = c.get("user").email;
    const b = createBody.parse(await c.req.json());
    assertRules(b);
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

  app.get("/:id", async (c) => c.json(publicPouch(await getOwnedPouch(deps, c.req.param("id"), c.get("user").email))));

  app.patch("/:id/rules", async (c) => {
    return deps.store.withPouchLock(c.req.param("id"),async()=> {
    const p = await getOwnedPouch(deps, c.req.param("id"), c.get("user").email);
    const b = updateBody.parse(await c.req.json());
    Object.assign(p, Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)));
    assertRules(p);
    await deps.vault.updateRules(p);
    return c.json(publicPouch(await deps.store.savePouch(p)));
    });
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
