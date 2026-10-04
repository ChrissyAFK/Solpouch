import { consumeAiBudget } from "../security/rateLimit.js";
import { validateOrderLines } from "./orderValidation.js";
import { PaymentPending } from "../vault/recovery.js";
import { randomBytes } from "node:crypto";
import { WEB_PREFIX, isAnyStore, isCheckoutReference, toMicros, type Merchant, type Order, type OrderLine, type Pouch } from "@solpouch/shared";
import { findOnline } from "../ai/findOnline.js";
import { catalogFit, fallbackMatch, matchItems, parseRequest, type ParsedItem } from "../ai/gemini.js";
import { getCatalog, getMerchant, merchants, registerWebMerchant } from "../merchants/index.js";
import { buildFulfillment, checkoutPayTo } from "./fulfillment.js";
import { recordPaidOrder } from "./metrics.js";
import type { GoogleUser } from "../auth/google.js";
import type { Store } from "../store/types.js";
import { heldAmount } from "./withdrawals.js";
import { VaultRejected, type VaultClient } from "../vault/types.js";

import type { FundingRepository } from "../funding/repository.js";

export interface Deps {
  fundingRepository?: FundingRepository;
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
  return withPaymentSignature(deps, o);
}

async function withPaymentSignature(deps: Deps, order: Order): Promise<Order> {
  if (order.status !== "paying" || order.txSignature) return order;
  const operation=await deps.store.getOperation(`pay:${order.id}`);
  return operation && operation.kind==="pay" && operation.pouchId===order.pouchId ? {...order,txSignature:operation.txSignature} : order;
}

export async function listOwnedOrders(deps: Deps, ownerEmail: string, pouchId?: string): Promise<Order[]> {
  if (pouchId) {
    await getOwnedPouch(deps, pouchId, ownerEmail);
    return Promise.all((await deps.store.listOrders(pouchId)).map(o=>withPaymentSignature(deps,o)));
  }
  const ids = new Set((await deps.store.listPouches(ownerEmail)).map((p) => p.id));
  return Promise.all((await deps.store.listOrders()).filter((o) => ids.has(o.pouchId)).map(o=>withPaymentSignature(deps,o)));
}

export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503, message: string, public code?: string) {
    super(message);
  }
}

/** parse -> pick pouch -> pick merchant -> match -> total. Returns a draft order. */
export async function createDraft(deps: Deps, ownerEmail: string, request: string, pouchId?: string, savedItems?: ParsedItem[]): Promise<Order> {
  await consumeAiBudget(deps.store, ownerEmail);
  const parsed = savedItems ? {items:savedItems} : await parseRequest(request);
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
    if (savedItems) {
      const matched = catalogLines;
      catalogLines = savedItems.map(item => {
        const line = matched.find(line => line.requested === item.requested) ?? fallbackMatch([item],getCatalog(best.id))[0];
        return {...line,requested:item.requested,requestedQty:item.qty,qty:line.product ? item.qty : 0,lineTotal:line.product ? line.product.unitPrice*item.qty : 0};
      });
    }
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
  if (found && !found.fallback) {
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
      total: validateOrderLines(lines),
      status: "draft",
      createdAt: new Date().toISOString(),
      store,
      fulfillment,
    });
  }

  if (mayGoOnline) {
    throw new HttpError(422, "Online search is unavailable. Try again later or choose items from a supported catalog.", "SearchUnavailable");
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
    total: validateOrderLines(lines),
    status: "draft",
    createdAt: new Date().toISOString(),
    fulfillment: { via: "direct", label: merchant.name },
  };
}

export async function confirmOrder(deps: Deps, ownerEmail: string, id: string, expectedVersion?: number): Promise<Order> {
  const initial = await getOwnedOrder(deps, id, ownerEmail);
  return deps.store.withPouchLock(initial.pouchId, async () => {
    let order = await getOwnedOrder(deps, id, ownerEmail);
    if (order.status === "paid") { await recordPaidOrder(deps.store, order); return order; }
    if (order.status !== "draft" && order.status !== "paying") throw new HttpError(409, `Order is ${order.status}`);
    if (order.status === "draft" && expectedVersion !== undefined && order.version !== expectedVersion) throw new HttpError(409, "This cart changed. Review it again before approving.", "RecordChanged");
    const pouch = await getOwnedPouch(deps, order.pouchId, ownerEmail);
    const merchant = getMerchant(order.merchantId);
    if (order.status === "draft" && !isAnyStore(pouch) && !pouch.allowedMerchantIds.includes(order.merchantId)) throw new HttpError(422,"This pouch no longer allows this store. Review its store rules before paying.","MerchantNotAllowed");
    if (isCheckoutReference(order) || !merchants.some(m=>m.id===order.merchantId)) throw new HttpError(422, "This is a search estimate, not a payable quote. Check the current price and complete checkout with the retailer. Solpouch has not placed an order.", "WebCheckoutRequired");
    if (!merchant) throw new HttpError(404,"Merchant not found");
    // Once paying, recover the original signed transaction even if rules changed later.
    if (order.status === "draft") {
      if (order.total <= 0 || validateOrderLines(order.lines) !== order.total) throw new HttpError(422,"Order total does not match its items");
      if (order.total > pouch.balance - (await heldAmount(deps.store, pouch.id))) {
        throw new HttpError(422, "Payment refused: InsufficientFunds", "InsufficientFunds");
      }
      order = await deps.store.saveOrder({...order,status:"paying"});
    }
    let txSignature: string;
    try {
      ({txSignature}=await deps.vault.pay(pouch,merchant.payTo,order.total,order.id));
    } catch(e) {
      if(e instanceof VaultRejected) {
        await deps.store.saveOrder({...order,status:"rejected",rejectReason:e.code});
        throw new HttpError(422,`Payment refused: ${e.code}`,e.code);
      }
      if (!(e instanceof PaymentPending) && !(await deps.store.getOperation(`pay:${order.id}`))) {
        await deps.store.saveOrder({...order,status:"draft"});
        throw new HttpError(503,"The payment could not be started. Nothing was charged; try again.","PaymentNotSent");
      }
      throw new HttpError(503,e instanceof PaymentPending ? e.message : "Payment is not confirmed yet. Retry this order to check its status.","PaymentPending");
    }
    try { const paid = await deps.store.saveOrder({...order,status:"paid",txSignature,paidAt:new Date().toISOString()}); await recordPaidOrder(deps.store,paid); return paid; }
    catch { throw new HttpError(503,"Payment was submitted. Retry this order to recover its receipt.","PaymentPending"); }
  });
}

export async function cancelOrder(deps: Deps, ownerEmail: string, id: string): Promise<Order> {
  const initial=await getOwnedOrder(deps,id,ownerEmail);
  return deps.store.withPouchLock(initial.pouchId,async()=>{
    const order=await getOwnedOrder(deps,id,ownerEmail);
    if(order.status!=="draft") throw new HttpError(409,`Order is ${order.status}, not draft`);
    return deps.store.saveOrder({...order,status:"cancelled"});
  });
}
