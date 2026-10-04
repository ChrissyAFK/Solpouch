import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { TopUp } from "@solpouch/shared";
import { HttpError, type Deps } from "../services/orders.js";
import { completeTopUp } from "../services/topups.js";
import { requestDeps } from "../security/access.js";

const startBody = z.object({
  pouchId: z.string().min(1).max(100),
  amount: z.number().int().positive().max(10_000_000_000),
  reason: z.string().trim().min(5, "Tell us why you need more money (at least 5 characters)").max(300),
}).strict();

/** Only the authenticated dashboard can fund pouches. Voice tools cannot top up. */
export function topupRoutes(_baseDeps: Deps) {
  const app = new Hono();
  app.post("/", async (c) => {
    const deps = requestDeps(c);
    const body = startBody.parse(await c.req.json());
    if (!(await deps.store.getPouch(body.pouchId))) throw new HttpError(404, "Pouch not found");
    const configured = process.env.TOPUP_COOLDOWN_SECONDS ?? "60";
    const cooldown = Number(configured);
    if (!configured.trim() || !Number.isSafeInteger(cooldown) || cooldown < 0 || cooldown > 86_400) {
      throw new HttpError(503, "Top-ups are temporarily unavailable. Please try again later.");
    }
    const now = Date.now();
    const topup: TopUp = {
      id: randomUUID(), pouchId: body.pouchId, amount: body.amount, reason: body.reason,
      status: "cooling_down",
      readyAt: new Date(now + cooldown * 1000).toISOString(),
      createdAt: new Date(now).toISOString(),
    };
    return c.json(await deps.store.saveTopUp(topup), 201);
  });
  app.get("/:id", async (c) => {
    const topup = await requestDeps(c).store.getTopUp(c.req.param("id"));
    if (!topup) throw new HttpError(404, "Top-up not found");
    return c.json(topup);
  });
  app.post("/:id/complete", async (c) => c.json(await completeTopUp(requestDeps(c), c.req.param("id"))));
  return app;
}
