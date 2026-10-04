import { reconcilePouches } from "../services/reconcile.js";
import { Hono } from "hono";
import { requestDeps } from "../security/access.js";
import { z } from "zod";
import { toUsdc, type Order } from "@solpouch/shared";
import { getMerchant } from "../merchants/index.js";
import { cancelOrder, confirmOrder, createDraft, HttpError, needsConfirmation, type Deps } from "../services/orders.js";

/**
 * ElevenLabs server-tool webhook.
 * SAFETY: there is deliberately no tool that tops up, creates pouches, changes rules or unfreezes.
 * The voice agent can only read, build a cart, confirm/cancel that cart, and freeze.
 */
export const VOICE_TOOLS = ["get_pouches", "create_order", "confirm_order", "cancel_order", "freeze_all"] as const;

/** A draft younger than this cannot be confirmed by voice. */
export const VOICE_CONFIRM_MIN_AGE_MS = 4000;

const usd =(m: number) => `$${toUsdc(m).toFixed(2)}`;

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
        try {
          const order = await createDraft(deps, b.request, b.pouchId);
          const pouch = await deps.store.getPouch(order.pouchId);
          const ask = !pouch || needsConfirmation(pouch, order.total);
          const say = ask ? readback(order) : `${readback(order)} This is under this pouch's ask-first amount, so I can place it right away if you want.`;
          return c.json({ say, orderId: order.id, total: usd(order.total), needsConfirmation: ask });
        } catch (e) {
          // Speakable failure instead of an error response the agent cannot read out.
          if (e instanceof HttpError) return c.json({ say: e.message, needsConfirmation: false, ...(e.code ? { code: e.code } : {}) });
          throw e;
        }
      }
      case "confirm_order": {
        const { orderId } = orderIdBody.parse(body);
        // Stop the model confirming in the same breath as creating: the user must hear the read-back first.
        const draft = await deps.store.getOrder(orderId);
        const draftPouch = draft?.status === "draft" ? await deps.store.getPouch(draft.pouchId) : undefined;
        const mustAsk = !draftPouch || needsConfirmation(draftPouch, draft!.total);
        if (mustAsk && draft?.status === "draft" && Date.now() - Date.parse(draft.createdAt) < VOICE_CONFIRM_MIN_AGE_MS) {
          return c.json({ say: "Please listen to the read-back first, then say yes again to place the order.", status: "draft", needsConfirmation: true });
        }
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
        const failed: string[] = [];
        for (const p of pouches) {
          try { await deps.store.withPouchLock(p.id, () => deps.vault.freeze(p.id)); } catch { failed.push(p.name); }
        }
        const done = pouches.length - failed.length;
        const say = failed.length === 0
          ? `Frozen. All ${pouches.length} pouches are locked until you unfreeze them in the app.`
          : `Frozen ${done} of ${pouches.length} pouches. These could not be frozen: ${failed.join(", ")}. Check them in the app.`;
        return c.json({ say, frozen: done, failed });
      }
      default:
        return c.json({ error: `Unknown tool: ${tool}` }, 404);
    }
  });

  return app;
}
