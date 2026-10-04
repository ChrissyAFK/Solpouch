import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Withdrawal } from "@solpouch/shared";
import { HttpError, type Deps } from "../services/orders.js";
import { heldAmount } from "../services/withdrawals.js";
import { requestDeps } from "../security/access.js";

const RECENT_MS = 7 * 24 * 3600_000;

const startBody = z.object({
  pouchId: z.string().min(1).max(100),
  amount: z.number().int().positive().max(10_000_000_000),
  reason: z.string().trim().max(300).optional(),
}).strict();

/** Withdrawals are held, then paid by the server sweeper. There is deliberately no client complete route. */
export function withdrawalRoutes(_baseDeps: Deps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const pouchId = c.req.query("pouchId");
    if (!pouchId) throw new HttpError(400, "pouchId is required");
    const all = await requestDeps(c).store.listWithdrawals(pouchId);
    const now = Date.now();
    return c.json(all.filter((w) =>
      w.status === "holding" || w.status === "processing" ||
      ((w.status === "completed" || w.status === "failed") && now - Date.parse(w.readyAt) <= RECENT_MS)));
  });

  app.post("/", async (c) => {
    const deps = requestDeps(c);
    const body = startBody.parse(await c.req.json());
    const user = await deps.store.getUser(c.get("email"));
    if (!user?.wallet) throw new HttpError(403, "Link a wallet to withdraw");
    if (!(await deps.store.getPouch(body.pouchId))) throw new HttpError(404, "Pouch not found");
    const configured = process.env.WITHDRAW_HOLD_SECONDS ?? "604800";
    const hold = Number(configured);
    if (!configured.trim() || !Number.isSafeInteger(hold) || hold < 0 || hold > 2_592_000) {
      throw new HttpError(503, "Withdrawals are temporarily unavailable. Please try again later.");
    }
    const wallet = user.wallet;
    return deps.store.withPouchLock(body.pouchId, async () => {
      const pouch = await deps.store.getPouch(body.pouchId);
      if (!pouch) throw new HttpError(404, "Pouch not found");
      if (pouch.frozen) throw new HttpError(409, "Unfreeze this pouch to withdraw", "PouchFrozen");
      const existing = await deps.store.listWithdrawals(body.pouchId);
      if (existing.some((w) => w.status === "holding" || w.status === "processing")) {
        throw new HttpError(409, "This pouch already has a withdrawal on hold", "WithdrawalPending");
      }
      // Orders in "paying" have an unknown outcome, so their money may already be gone.
      const unknown = (await deps.store.listOrders(body.pouchId))
        .filter((o) => o.status === "paying").reduce((s, o) => s + o.total, 0);
      if (body.amount > pouch.balance - (await heldAmount(deps.store, body.pouchId)) - unknown) {
        throw new HttpError(409, "Not enough money in this pouch", "InsufficientFunds");
      }
      const now = Date.now();
      const w: Withdrawal = {
        id: randomUUID(), pouchId: body.pouchId, amount: body.amount, reason: body.reason || "Withdrawal",
        toWallet: wallet, status: "holding",
        readyAt: new Date(now + hold * 1000).toISOString(),
        createdAt: new Date(now).toISOString(),
      };
      return c.json(await deps.store.saveWithdrawal(w), 201);
    });
  });

  app.get("/:id", async (c) => {
    const w = await requestDeps(c).store.getWithdrawal(c.req.param("id"));
    if (!w) throw new HttpError(404, "Withdrawal not found");
    return c.json(w);
  });

  app.post("/:id/cancel", async (c) => {
    const deps = requestDeps(c);
    const id = c.req.param("id");
    const initial = await deps.store.getWithdrawal(id);
    if (!initial) throw new HttpError(404, "Withdrawal not found");
    return deps.store.withPouchLock(initial.pouchId, async () => {
      const w = await deps.store.getWithdrawal(id);
      if (!w) throw new HttpError(404, "Withdrawal not found");
      const neverSent = w.status === "processing" && !(await deps.store.getOperation(`withdraw:${w.id}`));
      if (w.status !== "holding" && !neverSent) throw new HttpError(409, `Withdrawal is ${w.status}`);
      return c.json(await deps.store.saveWithdrawal({ ...w, status: "cancelled" }));
    });
  });

  return app;
}
