import { randomBytes } from "node:crypto";
import { WEB_PREFIX, isAnyStore, toMicros, type Merchant, type Order, type OrderLine, type Pouch } from "@solpouch/shared";
import { findOnline } from "../ai/findOnline.js";
import { catalogFit, matchItems, parseRequest } from "../ai/gemini.js";
import { getCatalog, getMerchant, merchants, registerWebMerchant } from "../merchants/index.js";
import { buildFulfillment, checkoutPayTo } from "./fulfillment.js";
import type { GoogleUser } from "../auth/google.js";
import type { Store } from "../store/types.js";
import { PaymentPending } from "../vault/recovery.js";
import { heldAmount } from "./withdrawals.js";
import { VaultRejected, type VaultClient } from "../vault/types.js";

export interface Deps {
  store: Store;
  vault: VaultClient;
  /** Override Google ID token verification (tests). */
  verifyGoogle?: (credential: string) => Promise<GoogleUser>;
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

  // 1. Catalog path.
  const candidateIds =
    !pouch || isAnyStore(pouch)
      ? merchants.map((m) => m.id)
      : pouch.allowedMerchantIds.filter((id) => merchants.some((m) => m.id === id));
  const best = candidateIds
    .map((id) => ({ id, fit: catalogFit(parsed.items, getCatalog(id)) }))
    .sort((a, b) => b.fit - a.fit)[0];
  let catalogLines: OrderLine[] | undefined;
  let covered = false;
  if (best && best.fit > 0) {
    catalogLines = await matchItems(parsed.items, getCatalog(best.id));
    covered = catalogLines.every((l) => l.product && l.matchScore >= 0.3);
  }

  const pickCatalogPouch = (id: string) =>
    pouches.find((p) => p.allowedMerchantIds.includes(id)) ?? pouches.find((p) => isAnyStore(p) && !p.frozen);
  const newId = () => randomBytes(16).toString("hex");

  if (best && catalogLines && covered) {
    const merchant = getMerchant(best.id)!;
    pouch ??= pickCatalogPouch(merchant.id);
    if (!pouch) throw new HttpError(400, `No pouch is allowed to pay ${merchant.name}`);
    return deps.store.saveOrder(catalogOrder(newId(), pouch, merchant, request, catalogLines));
  }

  // 2. Web path.
  const webDomains = (p: Pouch) =>
    p.allowedMerchantIds.filter((id) => id.startsWith(WEB_PREFIX)).map((id) => id.slice(WEB_PREFIX.length));
  const webAllowed = (p: Pouch) => isAnyStore(p) || webDomains(p).length > 0;
  let allowedDomains: string[] | undefined;
  if (pouch) {
    if (webAllowed(pouch)) allowedDomains = isAnyStore(pouch) ? undefined : webDomains(pouch);
  } else if (!pouches.some((p) => isAnyStore(p) && !p.frozen)) {
    const all = pouches.flatMap(webDomains);
    if (all.length) allowedDomains = all;
  }
  const mayGoOnline = pouch ? webAllowed(pouch) : pouches.some((p) => webAllowed(p));
  const found = mayGoOnline ? await findOnline(parsed.items, { allowedDomains }) : null;
  // The AI lookup failed and findOnline invented a placeholder store/price: never make that payable.
  if (found?.fallback) throw new HttpError(503, "Couldn't look that up right now. Try again in a minute.", "LookupFailed");
  if (found) {
    const { store, items } = found;
    const merchant = registerWebMerchant({
      id: WEB_PREFIX + store.domain,
      name: store.name,
      payTo: checkoutPayTo(),
      kind: "other",
      source: "web",
      url: store.url,
    });
    pouch ??=
      pouches.find((p) => isAnyStore(p) && !p.frozen) ?? pouches.find((p) => p.allowedMerchantIds.includes(merchant.id));
    if (!pouch) throw new HttpError(400, `No pouch is allowed to pay ${merchant.name}`);
    const lines: OrderLine[] = parsed.items.map((it) => {
      const w = items.find((i) => i.requested === it.requested);
      if (!w) {
        return { requested: it.requested, requestedQty: it.qty, product: null, qty: 0, lineTotal: 0, matchScore: 0, substitution: false, note: `Not found at ${store.domain}` };
      }
      const slug = w.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const unitPrice = toMicros(w.unitPrice);
      return {
        requested: it.requested,
        requestedQty: it.qty,
        product: {
          id: `${WEB_PREFIX}${store.domain}:${slug}`,
          merchantId: merchant.id,
          name: w.name,
          brand: w.brand,
          size: w.size,
          unitPrice,
          inStock: true,
          url: w.url,
          estimated: true,
        },
        qty: it.qty,
        lineTotal: unitPrice * it.qty,
        matchScore: 0.8,
        substitution: false,
        note: `Estimated price from ${store.domain}`,
      };
    });
    const fulfillment = await buildFulfillment(
      store,
      found.onInstacart,
      lines.filter((l) => l.product).map((l) => ({ name: l.product!.name, quantity: l.qty })),
    );
    return deps.store.saveOrder({
      id: newId(),
      pouchId: pouch.id,
      merchantId: merchant.id,
      request,
      lines,
      total: lines.reduce((s, l) => s + l.lineTotal, 0),
      status: "draft",
      createdAt: new Date().toISOString(),
      store,
      fulfillment,
    });
  }

  // 3. Both failed: partial catalog draft if anything matched, else an error.
  if (best && catalogLines) {
    const merchant = getMerchant(best.id)!;
    pouch ??= pickCatalogPouch(merchant.id);
    if (!pouch) throw new HttpError(400, `No pouch is allowed to pay ${merchant.name}`);
    return deps.store.saveOrder(catalogOrder(newId(), pouch, merchant, request, catalogLines));
  }
  if (pouch && !isAnyStore(pouch) && !webAllowed(pouch)) {
    const names = pouch.allowedMerchantIds.map((id) => getMerchant(id)?.name ?? id).join(", ");
    throw new HttpError(400, `This pouch only allows ${names}. Add the store or allow any store.`);
  }
  throw new HttpError(400, "No merchant sells what you asked for");
}

function catalogOrder(id: string, pouch: Pouch, merchant: Merchant, request: string, lines: OrderLine[]): Order {
  return {
    id,
    pouchId: pouch.id,
    merchantId: merchant.id,
    request,
    lines,
    total: lines.reduce((s, l) => s + l.lineTotal, 0),
    status: "draft",
    createdAt: new Date().toISOString(),
    fulfillment: { via: "direct", label: merchant.name },
  };
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
    let merchant = getMerchant(order.merchantId);
    if (!merchant && order.store) {
      merchant = registerWebMerchant({
        id: order.merchantId,
        name: order.store.name,
        payTo: checkoutPayTo(),
        kind: "other",
        source: "web",
        url: order.store.url,
      });
    }
    if (!pouch || !merchant) throw new HttpError(404, "Pouch or merchant not found");
    if (order.status === "draft") {
      // The pouch rules may have changed since the draft was made.
      if (!isAnyStore(pouch) && !pouch.allowedMerchantIds.includes(order.merchantId)) {
        await deps.store.saveOrder({ ...order, status: "rejected", rejectReason: "MerchantNotAllowed" });
        throw new HttpError(422, "Payment refused: MerchantNotAllowed", "MerchantNotAllowed");
      }
      if (order.total > pouch.balance - (await heldAmount(deps.store, pouch.id))) {
        throw new HttpError(422, "Payment refused: InsufficientFunds", "InsufficientFunds");
      }
      order = await deps.store.saveOrder({ ...order, status: "paying" });
    }
    let txSignature: string;
    try {
      ({ txSignature } = await deps.vault.pay(pouch, merchant.payTo, order.total, order.id));
    } catch (e) {
      // Any VaultRejected (including TxFailed/TxExpired) is terminal: no funds moved.
      if (e instanceof VaultRejected) {
        await deps.store.saveOrder({ ...order, status: "rejected", rejectReason: e.code });
        throw new HttpError(422, `Payment refused: ${e.code}`, e.code);
      }
      if (e instanceof PaymentPending) throw new HttpError(503, e.message, "PaymentPending");
      // No journal entry means no transaction was ever signed, so nothing can have been sent: go back to draft.
      if (!(await deps.store.getOperation(`pay:${order.id}`))) {
        await deps.store.saveOrder({ ...order, status: "draft" });
        throw new HttpError(503, "The payment could not be started. Nothing was charged; try again.", "PaymentNotSent");
      }
      // Keep paying: the chain may have accepted the transaction even if the response was lost.
      throw new HttpError(503, "Payment is not confirmed yet. Retry this order to check its status.", "PaymentPending");
    }
    // A persistence failure here leaves paying; the journal recovers the same signature on retry.
    return deps.store.saveOrder({ ...order, status: "paid", txSignature });
  });
}

/** Draft and rejected orders can be cancelled, and so can a "paying" order that was never broadcast. */
export async function cancelOrder(deps: Deps, id: string): Promise<Order> {
  const initial = await deps.store.getOrder(id);
  if (!initial) throw new HttpError(404, "Order not found");
  return deps.store.withPouchLock(initial.pouchId, async () => {
    const order = (await deps.store.getOrder(id))!;
    const neverSent = order.status === "paying" && !(await deps.store.getOperation(`pay:${order.id}`));
    if (order.status !== "draft" && order.status !== "rejected" && !neverSent) throw new HttpError(409, `Order is ${order.status}, not draft`);
    return deps.store.saveOrder({ ...order, status: "cancelled" });
  });
}
