import { randomBytes } from "node:crypto";
import { WEB_PREFIX, isAnyStore, toMicros, type Merchant, type Order, type OrderLine, type Pouch } from "@solpouch/shared";
import { findOnline } from "../ai/findOnline.js";
import { catalogFit, matchItems, parseRequest } from "../ai/gemini.js";
import { getCatalog, getMerchant, merchants, registerWebMerchant } from "../merchants/index.js";
import { buildFulfillment, checkoutPayTo } from "./fulfillment.js";
import type { Store } from "../store/types.js";
import { VaultRejected, type VaultClient } from "../vault/types.js";

export interface Deps {
  store: Store;
  vault: VaultClient;
}

export class HttpError extends Error {
  constructor(public status: 400 | 404 | 409 | 422, message: string, public code?: string) {
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
  const order = await deps.store.getOrder(id);
  if (!order) throw new HttpError(404, "Order not found");
  if (order.status !== "draft") throw new HttpError(409, `Order is ${order.status}, not draft`);
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

export async function cancelOrder(deps: Deps, id: string): Promise<Order> {
  const order = await deps.store.getOrder(id);
  if (!order) throw new HttpError(404, "Order not found");
  if (order.status !== "draft") throw new HttpError(409, `Order is ${order.status}, not draft`);
  order.status = "cancelled";
  return deps.store.saveOrder(order);
}
