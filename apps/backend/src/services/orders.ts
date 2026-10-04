import { randomBytes } from "node:crypto";
import type { Order, Pouch } from "@solpouch/shared";
import { catalogFit, matchItems, parseRequest } from "../ai/gemini.js";
import { getCatalog, getMerchant, merchants } from "../merchants/index.js";
import type { Store } from "../store/types.js";
import { PaymentPending } from "../vault/recovery.js";
import { VaultRejected, type VaultClient } from "../vault/types.js";

export interface Deps {
  store: Store;
  vault: VaultClient;
}

export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503, message: string, public code?: string) {
    super(message);
  }
}

/** parse -> pick pouch -> pick merchant -> match -> total. Returns a draft order. */
export async function createDraft(deps: Deps, request: string, pouchId?: string): Promise<Order> {
  const parsed = await parseRequest(request);
  if (!parsed.items.length) throw new HttpError(400, "Could not find any items in that request");
  const pouches = await deps.store.listPouches();

  let pouch: Pouch | undefined;
  if (pouchId) {
    pouch = pouches.find((p) => p.id === pouchId);
    if (!pouch) throw new HttpError(404, "Pouch not found");
  } else if (parsed.pouchHint) {
    const h = parsed.pouchHint.toLowerCase();
    pouch = pouches.find((p) => p.name.toLowerCase().includes(h) || h.includes(p.name.toLowerCase()));
  }

  const candidateIds = pouch ? pouch.allowedMerchantIds : merchants.map((m) => m.id);
  const best = candidateIds
    .map((id) => ({ id, fit: catalogFit(parsed.items, getCatalog(id)) }))
    .sort((a, b) => b.fit - a.fit)[0];
  if (!best || best.fit === 0) throw new HttpError(400, "No merchant sells what you asked for");
  const merchant = getMerchant(best.id)!;
  pouch ??= pouches.find((p) => p.allowedMerchantIds.includes(merchant.id));
  if (!pouch) throw new HttpError(400, `No pouch is allowed to pay ${merchant.name}`);

  const lines = await matchItems(parsed.items, getCatalog(merchant.id));
  const order: Order = {
    id: randomBytes(16).toString("hex"),
    pouchId: pouch.id,
    merchantId: merchant.id,
    request,
    lines,
    total: lines.reduce((s, l) => s + l.lineTotal, 0),
    status: "draft",
    createdAt: new Date().toISOString(),
  };
  return deps.store.saveOrder(order);
}

export async function confirmOrder(deps: Deps, id: string): Promise<Order> {
  const initial = await deps.store.getOrder(id);
  if (!initial) throw new HttpError(404, "Order not found");
  return deps.store.withPouchLock(initial.pouchId, async () => {
    let order = (await deps.store.getOrder(id))!;
    if (order.status === "paid") return order;
    if (order.status !== "draft" && order.status !== "paying") throw new HttpError(409, `Order is ${order.status}`);
    if (order.total <= 0) throw new HttpError(400, "Order has nothing to pay for");
    const pouch = await deps.store.getPouch(order.pouchId);
    const merchant = getMerchant(order.merchantId);
    if (!pouch || !merchant) throw new HttpError(404, "Pouch or merchant not found");
    if (order.status === "draft") order = await deps.store.saveOrder({ ...order, status: "paying" });
    let txSignature: string;
    try {
      ({ txSignature } = await deps.vault.pay(pouch, merchant.payTo, order.total, order.id));
    } catch (e) {
      if (e instanceof VaultRejected) {
        await deps.store.saveOrder({ ...order, status: "rejected", rejectReason: e.code });
        throw new HttpError(422, `Payment refused: ${e.code}`, e.code);
      }
      if (e instanceof PaymentPending) throw new HttpError(503, e.message, "PaymentPending");
      // Keep paying: the chain may have accepted the transaction even if the response was lost.
      throw new HttpError(503, "Payment is not confirmed yet. Retry this order to check its status.", "PaymentPending");
    }
    // A persistence failure here leaves paying; the journal recovers the same signature on retry.
    return deps.store.saveOrder({ ...order, status: "paid", txSignature });
  });
}

export async function cancelOrder(deps: Deps, id: string): Promise<Order> {
  const initial = await deps.store.getOrder(id);
  if (!initial) throw new HttpError(404, "Order not found");
  return deps.store.withPouchLock(initial.pouchId, async () => {
    const order = (await deps.store.getOrder(id))!;
    if (order.status !== "draft") throw new HttpError(409, `Order is ${order.status}, not draft`);
    return deps.store.saveOrder({ ...order, status: "cancelled" });
  });
}
