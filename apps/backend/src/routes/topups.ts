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

/** TOPUP_COOLDOWN_SECONDS (default 5). Throws a 503 when misconfigured. */
export function topupCooldownSeconds(): number {
  const configured = process.env.TOPUP_COOLDOWN_SECONDS ?? "5";
  const v = Number(configured);
  if (!configured.trim() || !Number.isSafeInteger(v) || v < 0) {
    throw new HttpError(503, "Top-ups are temporarily unavailable. Please try again later.");
  }
  return v;
}

/** TOPUP_DAILY_LIMIT_USDC (default 500) in micros. Throws a 503 when misconfigured. */
export function topupDailyLimitMicros(): number {
  const configured = process.env.TOPUP_DAILY_LIMIT_USDC ?? "500";
  const v = Number(configured);
  if (!configured.trim() || !Number.isFinite(v) || v <= 0 || v > 1_000_000_000) {
    throw new HttpError(503, "Top-ups are temporarily unavailable. Please try again later.");
  }
  return Math.round(v * 1_000_000);
}

/**
 * Top-ups are the ONLY way money enters a pouch, and are deliberately slow (friction).
 * This is owner/dashboard-only: it is NOT reachable from the voice tools or any agent path,
 * and a top-up can only start once the account has linked a wallet.
 */
export function topupRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) => {
    const pouchId = c.req.query("pouchId");
    const email=c.get("user").email;
    const ids = pouchId ? [(await getOwnedPouch(deps,pouchId,email)).id] : (await deps.store.listPouches(email)).map(p=>p.id);
    const all=(await Promise.all(ids.map(id=>deps.store.listTopUps(id)))).flat();
    const pending=all.filter(t=>t.status==="cooling_down" || t.status==="processing" || (t.status==="failed" && Date.now()-Date.parse(t.completedAt ?? t.readyAt)<=FAILED_TOPUP_VISIBLE_MS)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return c.json(await Promise.all(pending.map(async t=> {
      if(t.status!=="processing" || t.txSignature) return t;
      const operation=await deps.store.getOperation(`topup:${t.id}`);
      return operation && operation.kind==="topup" && operation.pouchId===t.pouchId ? {...t,txSignature:operation.txSignature} : t;
    })));
  });

  app.get("/:id", async (c) => {
    const topup = await deps.store.getTopUp(c.req.param("id"));
    if (!topup) throw new HttpError(404, "Top-up not found");
    await getOwnedPouch(deps, topup.pouchId, c.get("user").email);
    return c.json(topup);
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
    const email = c.get("user").email;
    await getOwnedPouch(deps, b.pouchId, email);
    // Only accounts that have proven they own a wallet may add money. The demo still
    // debits the backend owner key; fromWallet records the linked wallet for audit.
    const wallet = (await deps.store.getUser(email))?.wallet;
    if (!wallet) throw new HttpError(403, "Link a wallet to add money", "WalletRequired");
    const cooldown = topupCooldownSeconds();
    const cap = topupDailyLimitMicros();
    const now = Date.now();
    const since = now - 24 * 3600_000;
    const owned = await deps.store.listPouches(email);
    const recent = (await Promise.all(owned.map((p) => deps.store.listTopUps(p.id)))).flat()
      .filter((x) => x.status !== "cancelled" && x.status !== "failed" && Date.parse(x.createdAt) > since);
    const used = recent.reduce((s, x) => s + x.amount, 0);
    if (used + b.amount > cap) {
      const left = Math.max(0, cap - used);
      throw new HttpError(429, `Top-ups are limited to $${cap / 1_000_000} per 24 hours. You can add $${(left / 1_000_000).toFixed(2)} more right now.`, "TopUpLimit");
    }
    const t: TopUp = {
      id: randomUUID(),
      pouchId: b.pouchId,
      amount: b.amount,
      reason: b.reason || "Top-up",
      fromWallet: wallet,
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
