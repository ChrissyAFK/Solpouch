import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { consumeBudget, clientIp } from "../security/rateLimit.js";
import { verifyVoiceToken } from "../auth/session.js";
import { z } from "zod";
import { isCheckoutReference, toUsdc, type Order } from "@solpouch/shared";
import { getMerchant } from "../merchants/index.js";
import { cancelOrder, confirmOrder, createOrder, getOwnedOrder, HttpError, type Deps } from "../services/orders.js";

/**
 * ElevenLabs server-tool webhook.
 * SAFETY: there is deliberately no tool that tops up, creates pouches, changes rules or unfreezes.
 * The voice agent can only read, build a cart, confirm/cancel that cart, and freeze.
 */
export const VOICE_TOOLS = ["get_pouches", "create_order", "confirm_order", "cancel_order", "freeze_all"] as const;

const usd = (m: number) => `$${toUsdc(m).toFixed(2)}`;
let warned = false;
export const VOICE_CONFIRM_MIN_AGE_MS = 4000;

function itemsReadback(order: Order): string {
  const merchant = getMerchant(order.merchantId)?.name ?? "the merchant";
  const parts = order.lines.map((l) => (l.product ? `${l.qty} ${l.product.name}, ${usd(l.lineTotal)}` : `${l.requested}: nothing found`));
  return `From ${merchant}: ${parts.join("; ")}. Total ${usd(order.total)}.`;
}

const PENDING_SAY = "I sent that payment but can't confirm it yet, so it may have gone through. Don't start a new order. In a minute I can confirm this same order again; that only checks it and never pays twice.";

export function readback(order: Order): string {
  const merchant = getMerchant(order.merchantId)?.name ?? "the merchant";
  const parts = order.lines.map((l) => {
    if (!l.product) return `${l.requested}: nothing found`;
    const sub = l.substitution ? ` as a substitute. ${l.note ?? ""}`.trimEnd() : "";
    return `${l.qty} ${l.product.name}, ${usd(l.lineTotal)}${sub}`;
  });
  if (isCheckoutReference(order)) {
    return `From ${merchant}: ${parts.join("; ")}. Estimated total CAD ${usd(order.total)}. This is a search estimate only. Check current prices and complete checkout with the retailer using the link on the order page. Solpouch has not placed an order.`;
  }
  return `From ${merchant}: ${parts.join("; ")}. Total ${usd(order.total)}. Should I place it?`;
}

const requestBody = z.object({ request: z.string().min(1).max(1000), pouchId: z.string().max(100).optional(), user_token: z.string().optional() });
const orderIdBody = z.object({ orderId: z.string().min(1).max(100), user_token: z.string().optional() });

const MAX_FAILS = 10;
const LOCK_MS = 10 * 60_000;
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function voiceRoutes(deps: Deps) {
  const app = new Hono();

  app.post("/tools/:tool", async (c) => {
    const secret = process.env.VOICE_WEBHOOK_SECRET || process.env.ELEVENLABS_TOOL_SECRET;
    if (secret) {
      const ip = clientIp(c);
      if (!safeEqual(c.req.header("X-Solpouch-Secret") ?? "", secret)) {
        await consumeBudget(deps.store, `voice-secret:${ip}`, LOCK_MS, MAX_FAILS);
        return c.json({ error: "Unauthorized" }, 401);
      }
    } else if (process.env.NODE_ENV === "production") {
      return c.json({ error: "Voice tools are not configured" }, 503);
    } else if (!warned) {
      warned = true;
      console.warn("[voice] ELEVENLABS_TOOL_SECRET is unset: voice tool calls are NOT authenticated");
    }
    const tool = c.req.param("tool");
    if (!(VOICE_TOOLS as readonly string[]).includes(tool)) return c.json({ error: `Unknown tool: ${tool}` }, 404);
    const body = await c.req.json().catch(() => ({}));
    const authorization = c.req.header("Authorization");
    const credential = authorization === undefined ? (body as { user_token?: unknown } | null)?.user_token : /^Bearer (.+)$/.exec(authorization)?.[1];
    const email = await verifyVoiceToken(credential, deps.store);
    if (!email) return c.json({ say: "Please sign in to Solpouch first." }, 401);

    switch (tool) {
      case "get_pouches": {
        const pouches = await deps.store.listPouches(email);
        const say = pouches
          .map((p) => `${p.name}: ${usd(p.balance)} left, ${usd(Math.max(0, p.dailyLimit - p.spentToday))} available today${p.frozen ? ", frozen" : ""}`)
          .join(". ");
        return c.json({ say, pouches: pouches.map((p) => ({ id: p.id, name: p.name, balance: usd(p.balance), frozen: p.frozen })) });
      }
      case "create_order": {
        const b = requestBody.parse(body);
        try {
          const { order, autoPaid, autoPayError } = await createOrder(deps, email, b.request, b.pouchId, { autoPay: false });
          if (autoPaid) {
            const pouch = await deps.store.getPouch(order.pouchId);
            return c.json({ say: `Paid automatically, because it is within your ${usd(pouch?.confirmAbove ?? order.total)} auto-pay amount. ${itemsReadback(order)}`, orderId: order.id, version: order.version, total: usd(order.total), status: order.status, autoPaid: true, needsConfirmation: false, checkoutRequired: false });
          }
          if (autoPayError) {
            const say = autoPayError.code === "PaymentPending"
              ? PENDING_SAY
              : `I tried to pay this automatically but it was refused: ${autoPayError.code ?? autoPayError.message}. No money moved. ${itemsReadback(order)}`;
            return c.json({ say, orderId: order.id, version: order.version, total: usd(order.total), status: order.status, autoPaid: false, needsConfirmation: order.status === "draft", checkoutRequired: false, code: autoPayError.code });
          }
          return c.json({ say: readback(order), orderId: order.id, version: order.version, total: usd(order.total), needsConfirmation: !isCheckoutReference(order), checkoutRequired: isCheckoutReference(order) });
        } catch (e) {
          if (e instanceof HttpError) return c.json({say:e.message,needsConfirmation:false,...(e.code ? {code:e.code}: {})});
          throw e;
        }
      }
      case "confirm_order": {
        const { orderId, version } = orderIdBody.extend({version:z.number().int().positive().optional()}).parse(body);
        const draft = await getOwnedOrder(deps, orderId, email);
        if (draft.status === "draft" && draft.version !== (version ?? -1)) return c.json({say:"This cart changed. Review it again before approving.",status:"draft",code:"RecordChanged"});
        if (draft.status === "draft" && Date.now() - Date.parse(draft.createdAt) < VOICE_CONFIRM_MIN_AGE_MS) return c.json({say:"Please listen to the read-back first, then say yes again to place the order.",status:"draft",needsConfirmation:true});
        try {
          const order = await confirmOrder(deps, email, orderId, version ?? -1);
          return c.json({ say: order.txSignature?.startsWith("mock") ? `Demo payment recorded: ${usd(order.total)}. No real funds moved.` : `Payment recorded: ${usd(order.total)}.`, status: order.status });
        } catch (e) {
          if (e instanceof HttpError && (e.code === "WebCheckoutRequired" || e.code === "RecordChanged")) {
            return c.json({ say: e.message, status: "draft", code: e.code });
          }
          if (e instanceof HttpError && e.code === "PaymentPending") {
            // The outcome is unknown: money may have moved. Never tell the caller it was refused.
            return c.json({ say: PENDING_SAY, status: "paying", code: e.code });
          }
          if (e instanceof HttpError && e.code) {
            return c.json({ say: `That payment was refused: ${e.code}. No money moved.`, status: "rejected", code: e.code });
          }
          throw e;
        }
      }
      case "cancel_order": {
        const { orderId } = orderIdBody.parse(body);
        const order = await cancelOrder(deps, email, orderId);
        return c.json({ say: "Okay, cancelled.", status: order.status });
      }
      case "freeze_all": {
        const pouches = await deps.store.listPouches(email);
        const failed: string[] = [];
        for (const p of pouches) { try { await deps.store.withPouchLock(p.id, () => deps.vault.freeze(p.id)); } catch { failed.push(p.name); } }
        const frozen = pouches.length - failed.length;
        return c.json({say: failed.length ? `Frozen ${frozen} of ${pouches.length} pouches. These could not be frozen: ${failed.join(", ")}. Check them in the app.` : `Frozen. All ${frozen} pouches are locked until you unfreeze them in the app.`,frozen,failed});
      }
      default:
        return c.json({ error: `Unknown tool: ${tool}` }, 404);
    }
  });

  return app;
}
