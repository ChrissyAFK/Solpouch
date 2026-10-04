import { reconcilePouches } from "../services/reconcile.js";
import { Hono } from "hono";
import { requestDeps } from "../security/access.js";
import { z } from "zod";
import { toUsdc, type Order } from "@solpouch/shared";
import { getMerchant } from "../merchants/index.js";
import { cancelOrder, confirmOrder, createDraft, HttpError, type Deps } from "../services/orders.js";

/**
 * ElevenLabs server-tool webhook.
 * SAFETY: there is deliberately no tool that tops up, creates pouches, changes rules or unfreezes.
 * The voice agent can only read, build a cart, confirm/cancel that cart, and freeze.
 */
export const VOICE_TOOLS = ["get_pouches", "create_order", "confirm_order", "cancel_order", "freeze_all"] as const;

const usd = (m: number) => `$${toUsdc(m).toFixed(2)}`;

export function readback(order: Order): string {
  const merchant = getMerchant(order.merchantId)?.name ?? "the merchant";
  const parts = order.lines.map((l) => {
    if (!l.product) return `${l.requested}: nothing found`;
    const sub = l.substitution ? ` as a substitute. ${l.note ?? ""}`.trimEnd() : "";
    return `${l.qty} ${l.product.name}, ${usd(l.lineTotal)}${sub}`;
  });
  return `From ${merchant}: ${parts.join("; ")}. Total ${usd(order.total)}. Should I place it?`;
}

const requestBody = z.object({ request: z.string().trim().min(1).max(1000), pouchId: z.string().min(1).max(100).optional(), user_token: z.string().optional() }).strict();
const orderIdBody = z.object({ orderId: z.string().min(1).max(100), user_token: z.string().optional() }).strict();

export function voiceRoutes(_baseDeps: Deps) {
  const app = new Hono();
  // Secret verification and wallet-scoped authentication are mandatory app middleware.
  app.post("/tools/:tool", async (c) => {
    const deps = requestDeps(c);
    const tool = c.req.param("tool");
    const body = await c.req.json();

    switch (tool) {
      case "get_pouches": {
        const pouches = await reconcilePouches(deps);
        const say = pouches
          .map((p) => `${p.name}: ${usd(p.balance)} left, ${usd(Math.max(0, p.dailyLimit - p.spentToday))} available today${p.frozen ? ", frozen" : ""}`)
          .join(". ");
        return c.json({ say, pouches: pouches.map((p) => ({ id: p.id, name: p.name, balance: usd(p.balance), frozen: p.frozen })) });
      }
      case "create_order": {
        const b = requestBody.parse(body);
        const order = await createDraft(deps, b.request, b.pouchId);
        return c.json({ say: readback(order), orderId: order.id, total: usd(order.total), needsConfirmation: true });
      }
      case "confirm_order": {
        const { orderId } = orderIdBody.parse(body);
        try {
          const order = await confirmOrder(deps, orderId);
          return c.json({ say: order.txSignature?.startsWith("mock") ? `Demo payment recorded: ${usd(order.total)}. No real funds moved.` : `Payment recorded: ${usd(order.total)}.`, status: order.status });
        } catch (e) {
          if (e instanceof HttpError && e.code) {
            return c.json({ say: `The payment could not be confirmed: ${e.code}. Check its status in the app before retrying.`, status: "unconfirmed", code: e.code });
          }
          throw e;
        }
      }
      case "cancel_order": {
        const { orderId } = orderIdBody.parse(body);
        const order = await cancelOrder(deps, orderId);
        return c.json({ say: "Okay, cancelled.", status: order.status });
      }
      case "freeze_all": {
        const pouches = await reconcilePouches(deps);
        for (const p of pouches) await deps.store.withPouchLock(p.id, () => deps.vault.freeze(p.id));
        return c.json({ say: `Frozen. All ${pouches.length} pouches are locked until you unfreeze them in the app.` });
      }
      default:
        return c.json({ error: `Unknown tool: ${tool}` }, 404);
    }
  });

  return app;
}
