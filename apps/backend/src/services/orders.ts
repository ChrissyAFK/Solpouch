import { randomBytes } from "node:crypto";
import type { Order, Pouch } from "@solpouch/shared";
import { catalogFit, matchItems, parseRequest } from "../ai/gemini.js";
import { getCatalog, getMerchant, merchants } from "../merchants/index.js";
import type { GoogleUser } from "../auth/google.js";
import type { Store } from "../store/types.js";
import { VaultRejected, type VaultClient } from "../vault/types.js";

export interface Deps {
  store: Store;
  vault: VaultClient;
  /** Override Google ID token verification (tests). */
  verifyGoogle?: (credential: string) => Promise<GoogleUser>;
}

/** The pouch if it exists AND belongs to ownerEmail, else 404 (never reveals other users' pouches). */
export async function getOwnedPouch(deps: Deps, id: string, ownerEmail: string) {
  const p = await deps.store.getPouch(id);
  if (!p || p.ownerEmail !== ownerEmail) throw new HttpError(404, "Pouch not found");
  return p;
}

/** The order if its pouch belongs to ownerEmail, else 404. */
export async function getOwnedOrder(deps: Deps, id: string, ownerEmail: string): Promise<Order> {
  const o = await deps.store.getOrder(id);
  if (!o) throw new HttpError(404, "Order not found");
  const p = await deps.store.getPouch(o.pouchId);
  if (!p || p.ownerEmail !== ownerEmail) throw new HttpError(404, "Order not found");
  return o;
}

export async function listOwnedOrders(deps: Deps, ownerEmail: string, pouchId?: string): Promise<Order[]> {
  if (pouchId) {
    await getOwnedPouch(deps, pouchId, ownerEmail);
    return deps.store.listOrders(pouchId);
  }
  const ids = new Set((await deps.store.listPouches(ownerEmail)).map((p) => p.id));
  return (await deps.store.listOrders()).filter((o) => ids.has(o.pouchId));
}

export class HttpError extends Error {
  constructor(public status: 400 | 404 | 409 | 422, message: string, public code?: string) {
    super(message);
  }
}

/** parse -> pick pouch -> pick merchant -> match -> total. Returns a draft order. */
export async function createDraft(deps: Deps, ownerEmail: string, request: string, pouchId?: string): Promise<Order> {
  const parsed = await parseRequest(request);
  if (!parsed.items.length) throw new HttpError(400, "Could not find any items in that request");
  const pouches = await deps.store.listPouches(ownerEmail);

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

export async function confirmOrder(deps: Deps, ownerEmail: string, id: string): Promise<Order> {
  const order = await getOwnedOrder(deps, id, ownerEmail);
  if (order.status !== "draft") throw new HttpError(409, `Order is ${order.status}, not draft`);
  if (order.total <= 0) throw new HttpError(400, "Order has nothing to pay for");
  const pouch = await deps.store.getPouch(order.pouchId);
  const merchant = getMerchant(order.merchantId);
  if (!pouch || !merchant) throw new HttpError(404, "Pouch or merchant not found");

  order.status = "paying";
  await deps.store.saveOrder(order);
  try {
    const { txSignature } = await deps.vault.pay(pouch, merchant.payTo, order.total, order.id);
    order.status = "paid";
    order.txSignature = txSignature;
    await deps.store.saveOrder(order);
    return order;
  } catch (e) {
    if (e instanceof VaultRejected) {
      order.status = "rejected";
      order.rejectReason = e.code;
      await deps.store.saveOrder(order);
      throw new HttpError(422, `Payment refused: ${e.code}`, e.code);
    }
    order.status = "draft";
    await deps.store.saveOrder(order);
    throw e;
  }
}

export async function cancelOrder(deps: Deps, ownerEmail: string, id: string): Promise<Order> {
  const order = await getOwnedOrder(deps, id, ownerEmail);
  if (order.status !== "draft") throw new HttpError(409, `Order is ${order.status}, not draft`);
  order.status = "cancelled";
  return deps.store.saveOrder(order);
}
