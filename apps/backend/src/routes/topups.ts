import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { TopUp } from "@solpouch/shared";
import type { AuthEnv } from "../auth/session.js";
import { getOwnedPouch, HttpError, type Deps } from "../services/orders.js";

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
    if (!pouchId) throw new HttpError(400, "pouchId is required");
    await getOwnedPouch(deps, pouchId, c.get("user").email);
    const all = await deps.store.listTopUps(pouchId);
    return c.json(all.filter((t) => t.status === "cooling_down"));
  });

  app.post("/:id/cancel", async (c) => {
    const t = await deps.store.getTopUp(c.req.param("id"));
    if (!t) throw new HttpError(404, "Top-up not found");
    const owner = await deps.store.getPouch(t.pouchId);
    if (!owner || owner.ownerEmail !== c.get("user").email) throw new HttpError(404, "Top-up not found");
    if (t.status !== "cooling_down") throw new HttpError(409, `Top-up is ${t.status}`);
    t.status = "cancelled";
    return c.json(await deps.store.saveTopUp(t));
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
    const t = await deps.store.getTopUp(c.req.param("id"));
    if (!t) throw new HttpError(404, "Top-up not found");
    const owner = await deps.store.getPouch(t.pouchId);
    if (!owner || owner.ownerEmail !== c.get("user").email) throw new HttpError(404, "Top-up not found");
    if (t.status !== "cooling_down") throw new HttpError(409, `Top-up is ${t.status}`);
    if (Date.now() < new Date(t.readyAt).getTime()) {
      throw new HttpError(409, `Cooldown not over yet, ready at ${t.readyAt}`, "CooldownActive");
    }
    await deps.vault.topUp(t.pouchId, t.amount);
    t.status = "completed";
    return c.json(await deps.store.saveTopUp(t));
  });

  return app;
}
