import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { TopUp } from "@solpouch/shared";
import { HttpError, type Deps } from "../services/orders.js";

const startBody = z.object({
  pouchId: z.string(),
  amount: z.number().int().positive(),
  reason: z.string().trim().min(5, "Tell us why you need more money (at least 5 characters)"),
});

/**
 * Top-ups are the ONLY way money enters a pouch, and are deliberately slow (friction).
 * This is owner/dashboard-only: it is NOT reachable from the voice tools or any agent path.
 */
export function topupRoutes(deps: Deps) {
  const app = new Hono();

  app.post("/", async (c) => {
    const b = startBody.parse(await c.req.json());
    if (!(await deps.store.getPouch(b.pouchId))) throw new HttpError(404, "Pouch not found");
    const cooldown = Number(process.env.TOPUP_COOLDOWN_SECONDS ?? 60);
    const now = Date.now();
    const t: TopUp = {
      id: randomUUID(),
      pouchId: b.pouchId,
      amount: b.amount,
      reason: b.reason,
      status: "cooling_down",
      readyAt: new Date(now + cooldown * 1000).toISOString(),
      createdAt: new Date(now).toISOString(),
    };
    return c.json(await deps.store.saveTopUp(t), 201);
  });

  app.post("/:id/complete", async (c) => {
    const t = await deps.store.getTopUp(c.req.param("id"));
    if (!t) throw new HttpError(404, "Top-up not found");
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
