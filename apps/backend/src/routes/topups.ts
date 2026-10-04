import { completeTopUp } from "../services/topups.js";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { TopUp } from "@solpouch/shared";
import type { AuthEnv } from "../auth/session.js";
import { getOwnedPouch, HttpError, type Deps } from "../services/orders.js";

export const FAILED_TOPUP_VISIBLE_MS = 10 * 60_000;

const startBody = z.object({
  pouchId: z.string().max(100),
  amount: z.number().int().positive().max(10_000_000_000),
  reason: z.string().trim().max(300).optional(),
});

/**
 * Top-ups are the ONLY way money enters a pouch, and are deliberately slow (friction).
 * This is owner/dashboard-only: it is NOT reachable from the voice tools or any agent path.
 */
export function topupRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) => {
    const pouchId = c.req.query("pouchId");
    const email=c.get("user").email;
    const ids = pouchId ? [(await getOwnedPouch(deps,pouchId,email)).id] : (await deps.store.listPouches(email)).map(p=>p.id);
    const all=(await Promise.all(ids.map(id=>deps.store.listTopUps(id)))).flat();
    const pending=all.filter(t=>t.status==="cooling_down" || t.status==="processing").sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return c.json(await Promise.all(pending.map(async t=> {
      if(t.status!=="processing" || t.txSignature) return t;
      const operation=await deps.store.getOperation(`topup:${t.id}`);
      return operation && operation.kind==="topup" && operation.pouchId===t.pouchId ? {...t,txSignature:operation.txSignature} : t;
    })));
  });

  app.post("/:id/cancel", async (c) => {
    const initial = await deps.store.getTopUp(c.req.param("id"));
    if (!initial) throw new HttpError(404,"Top-up not found");
    return deps.store.withPouchLock(initial.pouchId, async()=> {
      await getOwnedPouch(deps,initial.pouchId,c.get("user").email);
      const t=(await deps.store.getTopUp(initial.id))!;
      if(t.status!=="cooling_down") throw new HttpError(409,`Top-up is ${t.status}`);
      return c.json(await deps.store.saveTopUp({...t,status:"cancelled"}));
    });
  });

  app.post("/", async (c) => {
    const b = startBody.parse(await c.req.json());
    await getOwnedPouch(deps, b.pouchId, c.get("user").email);
    const cooldown = Number(process.env.TOPUP_COOLDOWN_SECONDS ?? 60);
    const now = Date.now();
    const t: TopUp = {
      id: randomUUID(),
      pouchId: b.pouchId,
      amount: b.amount,
      reason: b.reason || "Top-up",
      status: "cooling_down",
      readyAt: new Date(now + cooldown * 1000).toISOString(),
      createdAt: new Date(now).toISOString(),
    };
    return c.json(await deps.store.saveTopUp(t), 201);
  });

  app.post("/:id/complete", async (c) => {
    return c.json(await completeTopUp(deps,c.get("user").email,c.req.param("id")));
  });

  return app;
}
