import { validateDemoCheckout } from "./demoCheckout.js";
import { consumeAiBudget } from "../security/rateLimit.js";
import { validateOrderLines } from "./orderValidation.js";
import { PaymentPending } from "../vault/recovery.js";
import { randomBytes } from "node:crypto";
import { WEB_PREFIX, isAnyStore, isCheckoutReference, toMicros, type Merchant, type Order, type OrderLine, type Pouch } from "@solpouch/shared";
import { findCart } from "../ai/findCart.js";
import { SearchUnavailableError, storeMatches } from "../ai/storeMatch.js";
import { catalogFit, fallbackMatch, matchItems, type ParsedItem } from "../ai/gemini.js";
import { aiProvider } from "../ai/provider.js";
import { understand, type Understood } from "../ai/understand.js";
import { getCatalog, getMerchant, merchants, registerWebMerchant } from "../merchants/index.js";
import { parseRequestConstraints } from "./request-constraints.js";
import { buildFulfillment, checkoutPayTo } from "./fulfillment.js";
import { recordPaidOrder } from "./metrics.js";
import type { GoogleUser } from "../auth/google.js";
import type { Store } from "../store/types.js";
import { heldAmount } from "./withdrawals.js";
import { VaultRejected, type VaultClient } from "../vault/types.js";

import type { FundingRepository } from "../funding/repository.js";

export interface Deps {
  stripeRepository?: import('../stripe/repository.js').StripeRepository;
  stripeProvider?: import('../stripe/provider.js').StripeProvider;
  stripeMint?: (request: import('../stripe/repository.js').StripeFundingRequest, repository: import('../stripe/repository.js').StripeRepository) => Promise<{txSignature:string}>;
  fundingRepository?: FundingRepository;
  store: Store;
  vault: VaultClient;
  /** Wallet-transfer chain access for /allocations. Defaults to the real RPC in chain mode; tests inject a fake. */
  allocationChain?: import('../vault/allocationChain.js').AllocationChain;
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

/** Lowest matchScore a catalog line may have to count as covering the request. */
export const MATCH_THRESHOLD = 0.3;
/** The same floor once real search is available: a catalog line must be a close match, not a look-alike. */
export const MATCH_THRESHOLD_ONLINE = 0.6;
/** Auto-pay moves money without asking, so every line must be a near-exact match (1 = exactly what was asked). */
export const AUTO_CONFIRM_MATCH = 0.9;

/**
 * Whether a fresh draft may be paid without asking (Pouch.confirmAbove).
 * Deliberately conservative: only built-in catalog quotes within the owner's
 * auto-pay amount whose every line is exactly what was asked for, and only when
 * the pouch's local rules show the payment should succeed. Anything else stays a
 * draft for explicit confirmation.
 */
export function autoConfirmEligible(pouch: Pouch, order: Order): boolean {
  if (!(pouch.confirmAbove > 0) || order.status !== "draft" || order.pouchId !== pouch.id) return false;
  if (order.fulfillment?.via === "demo" || isCheckoutReference(order) || !merchants.some((m) => m.id === order.merchantId)) return false;
  if (!isAnyStore(pouch) && !pouch.allowedMerchantIds.includes(order.merchantId)) return false;
  if (!(order.total > 0) || order.total > pouch.confirmAbove) return false;
  if (pouch.frozen || order.total > pouch.maxPerOrder || order.total > pouch.balance || pouch.spentToday + order.total > pouch.dailyLimit) return false;
  if (!order.lines.length) return false;
  // A price limit in the request is enforced by code: such an order always waits for the user's yes.
  if (parseRequestConstraints(order.request ?? "").hasConstraint) return false;
  return order.lines.every((l) =>
    !!l.product && l.product.inStock && !l.product.estimated && l.product.merchantId === order.merchantId &&
    !l.substitution && !l.note && l.matchScore >= AUTO_CONFIRM_MATCH && l.qty === l.requestedQty && l.qty > 0);
}

export interface CreatedOrder {
  order: Order;
  /** True only when the draft was paid without asking because of confirmAbove. */
  autoPaid: boolean;
  /** Set when an auto-pay attempt was made but did not finish as paid. */
  autoPayError?: HttpError;
}

/** createDraft, then pay it immediately only when autoConfirmEligible allows it. */
export async function createOrder(deps: Deps, ownerEmail: string, request: string, pouchId?: string, opts: { autoPay?: boolean } = {}): Promise<CreatedOrder> {
  let draft = await createDraft(deps, ownerEmail, request, pouchId);
  const { maxPrice, perItem } = parseRequestConstraints(request);
  if (maxPrice !== undefined && !perItem && draft.total > maxPrice && draft.lines.length) {
    const note = `Over your limit of $${(maxPrice / 1_000_000).toFixed(2)}: this order totals $${(draft.total / 1_000_000).toFixed(2)}`;
    const lines = draft.lines.map((l, i) => (i === 0 ? { ...l, note: l.note ? `${l.note}; ${note}` : note } : l));
    draft = await deps.store.saveOrder({ ...draft, lines });
  }
  if (opts.autoPay === false) return { order: draft, autoPaid: false }; // voice always needs the spoken yes
  const pouch = await deps.store.getPouch(draft.pouchId);
  if (!pouch || pouch.ownerEmail !== ownerEmail || !autoConfirmEligible(pouch, draft)) return { order: draft, autoPaid: false };
  try {
    const order = await confirmOrder(deps, ownerEmail, draft.id, undefined, { auto: true });
    return { order, autoPaid: order.status === "paid" };
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return { order: await getOwnedOrder(deps, draft.id, ownerEmail), autoPaid: false, autoPayError: e };
  }
}

const GENERIC_WORDS = new Set(["a", "an", "the", "some", "any", "my", "me", "order", "orders", "meal", "meals", "combo", "combos", "something", "food", "lunch", "dinner", "breakfast", "from", "at", "of", "for", "to", "get", "typical", "good", "cheap"]);
/** The user left the choice to the assistant ("anything", "you pick", "surprise me"). */
const VAGUE_ANSWER = /\b(anything|any ?thing|whatever|idk|i don'?t know|surprise me|you pick|you choose|your choice|doesn'?t matter|does not matter|don'?t care|up to you|any)\b/i;

/** parse -> pick pouch -> pick merchant -> match -> total. Returns a draft order. */
export async function createDraft(deps: Deps, ownerEmail: string, request: string, pouchId?: string, savedItems?: ParsedItem[]): Promise<Order> {
  await consumeAiBudget(deps.store, ownerEmail);
  const online = aiProvider() !== "none";
  const unavailable = () => new HttpError(503, "I can't search right now. Try again in a minute.", "SearchUnavailable");
  let parsed: Understood;
  try {
    parsed = savedItems ? { items: savedItems } : await understand(request);
  } catch (e) {
    if (e instanceof SearchUnavailableError) throw unavailable();
    throw e;
  }
  // The assistant asks one question instead of guessing; the answer comes back as a new request.
  const { maxPrice, perItem } = parseRequestConstraints(request);
  let cap = maxPrice !== undefined ? maxPrice / 1_000_000 : undefined;
  // "a mcdonalds order" names no item: generic words (and the store name) do not count as items.
  if (parsed.store && parsed.items.length && !savedItems) {
    const storeWords = parsed.store.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const isGeneric = (s: string) =>
      s.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean).every((w) => GENERIC_WORDS.has(w) || storeWords.includes(w.replace(/'?s$/, "")) || storeWords.includes(w));
    if (parsed.items.every((i) => isGeneric(i.requested))) parsed = { ...parsed, items: [] };
  }
  const vague = VAGUE_ANSWER.test(request);
  // A store plus a price cap (or a "you pick" answer) with no items: the search picks a typical order that fits.
  const chooseItems = !parsed.items.length && !!parsed.store && (cap !== undefined || vague);
  // The assistant asks one question instead of guessing; never when we can just build a cart.
  if (parsed.clarify && !chooseItems) throw new HttpError(400, parsed.clarify.question, "NeedClarification");
  if (!parsed.items.length && !chooseItems) {
    throw new HttpError(400, parsed.store ? `What would you like from ${parsed.store}?` : "What would you like me to order?", "NeedClarification");
  }
  const pouches = await deps.store.listPouches(ownerEmail);

  const webDomains = (p: Pouch) =>
    p.allowedMerchantIds.filter((id) => id.startsWith(WEB_PREFIX)).map((id) => id.slice(WEB_PREFIX.length));
  const webAllowed = (p: Pouch) => isAnyStore(p) || webDomains(p).length > 0;
  const byName = (hint?: string) => {
    const h = hint?.trim().toLowerCase();
    return h ? pouches.find((p) => p.name.toLowerCase().includes(h) || h.includes(p.name.toLowerCase())) : undefined;
  };
  let pouch: Pouch | undefined;
  if (pouchId) {
    pouch = pouches.find((p) => p.id === pouchId);
    if (!pouch) throw new HttpError(404, "Pouch not found");
  } else {
    pouch = byName(parsed.pouchHint) ?? byName(parsed.service);
    // A pouch chosen only by a hint or the delivery service is dropped when it cannot pay this request.
    if (pouch && !isAnyStore(pouch) || pouch?.frozen) {
      const pp = pouch;
      const canPay = !pp.frozen && (webDomains(pp).length > 0 || pp.allowedMerchantIds.some((id) => {
        const mer = getMerchant(id);
        if (!mer) return false;
        return parsed.store ? storeMatches(parsed.store, mer.name) : catalogFit(parsed.items, getCatalog(id)) > 0;
      }));
      if (!canPay) pouch = undefined;
    }
  }

  // A "you pick" answer with no budget: spend up to what the pouch can pay.
  if (chooseItems && cap === undefined) {
    const sp = pouch ?? pouches.find((p) => isAnyStore(p) && !p.frozen) ?? pouches.find((p) => !p.frozen);
    if (sp) cap = Math.max(0, Math.min(sp.balance, sp.maxPerOrder, sp.dailyLimit - sp.spentToday)) / 1_000_000;
  }

  // 1. Catalog path.
  let candidateIds =
    !pouch || isAnyStore(pouch)
      ? merchants.map((m) => m.id)
      : pouch.allowedMerchantIds.filter((id) => merchants.some((m) => m.id === id));
  // A named store only matches its own catalog; any other name skips the catalog (no look-alikes).
  if (parsed.store) candidateIds = candidateIds.filter((id) => storeMatches(parsed.store!, getMerchant(id)?.name ?? ""));
  // With real search available, a built-in catalog is used only when the user names that merchant,
  // the pouch allows nothing else, or the items come from a saved list. No look-alikes for everyday requests.
  const catalogOnlyPouch = !!pouch && !isAnyStore(pouch) && !webAllowed(pouch);
  const mayGoOnline = pouch ? webAllowed(pouch) : pouches.some((p) => webAllowed(p));
  const catalogFallback = !online || catalogOnlyPouch || !mayGoOnline || !!savedItems;
  if (!catalogFallback && !parsed.store) candidateIds = [];
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
    covered = catalogLines.every((l) => l.product && l.matchScore >= (online && !savedItems ? MATCH_THRESHOLD_ONLINE : MATCH_THRESHOLD));
  }

  const pickCatalogPouch = (id: string) =>
    pouches.find((p) => !p.frozen && p.allowedMerchantIds.includes(id)) ?? pouches.find((p) => isAnyStore(p) && !p.frozen);
  const newId = () => randomBytes(16).toString("hex");

  if (best && catalogLines && covered) {
    const merchant = getMerchant(best.id)!;
    pouch ??= pickCatalogPouch(merchant.id);
    if (!pouch) throw new HttpError(400, `No pouch is allowed to pay ${merchant.name}`);
    return deps.store.saveOrder(catalogOrder(newId(), pouch, merchant, request, catalogLines));
  }

  // 2. Web path.
  let allowedDomains: string[] | undefined;
  if (pouch) {
    if (webAllowed(pouch)) allowedDomains = isAnyStore(pouch) ? undefined : webDomains(pouch);
  } else if (!pouches.some((p) => isAnyStore(p) && !p.frozen)) {
    const all = pouches.flatMap(webDomains);
    if (all.length) allowedDomains = all;
  }
  let found: Awaited<ReturnType<typeof findCart>> = null;
  if (mayGoOnline) {
    try {
      found = await findCart(parsed.items, {
        allowedDomains, store: parsed.store, service: parsed.service, ...(chooseItems ? { chooseItems: true } : {}),
        ...(cap !== undefined ? (perItem ? { maxPerItem: cap } : { maxTotal: cap }) : {}),
      });
    } catch (e) {
      if (!(e instanceof SearchUnavailableError)) throw e;
      throw unavailable();
    }
  }
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
      pouches.find((p) => isAnyStore(p) && !p.frozen) ?? pouches.find((p) => !p.frozen && p.allowedMerchantIds.includes(merchant.id));
    if (!pouch) throw new HttpError(400, `No pouch is allowed to pay ${merchant.name}`);
    const wanted: ParsedItem[] = chooseItems ? items.map((i) => ({ requested: i.requested, qty: 1 })) : parsed.items;
    const lines: OrderLine[] = wanted.map((it) => {
      const w = items.find((i) => i.requested === it.requested);
      if (!w) {
        return { requested: it.requested, requestedQty: it.qty, product: null, qty: 0, lineTotal: 0, matchScore: 0, substitution: false, note: `Not found at ${store.domain}` };
      }
      const slug = w.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const unitPrice = toMicros(w.unitPrice);
      // Verified = the price was read from the product's own page; anything else is an estimate to check.
      const verified = w.verified === true;
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
          estimated: !verified,
        },
        qty: it.qty,
        lineTotal: unitPrice * it.qty,
        matchScore: verified ? 0.95 : 0.8,
        substitution: false,
        ...(verified ? {} : { note: `Estimated price from ${store.domain}. Check it before paying.` }),
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
    if (found?.fallback) throw unavailable();
    const what = chooseItems ? "an order" : parsed.items.map((i) => i.requested).join(", ");
    throw new HttpError(422, `Couldn't find ${what}${parsed.store ? ` from ${parsed.store}` : ""}${allowedDomains ? " at the stores this pouch allows" : ""}. Try rewording or naming a store.`.replace(/\s+/g, " "), "NotFound");
  }

  // 3. Both failed: partial catalog draft if anything matched, else an error.
  if (best && catalogLines && (catalogFallback || covered)) {
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

export async function confirmOrder(deps: Deps, ownerEmail: string, id: string, expectedVersion?: number, opts: { auto?: boolean } = {}): Promise<Order> {
  const initial = await getOwnedOrder(deps, id, ownerEmail);
  return deps.store.withPouchLock(initial.pouchId, async () => {
    let order = await getOwnedOrder(deps, id, ownerEmail);
    if (order.status === "paid") { await recordPaidOrder(deps.store, order); return order; }
    if (order.status !== "draft" && order.status !== "paying") throw new HttpError(409, `Order is ${order.status}`);
    if (order.status === "draft" && expectedVersion !== undefined && order.version !== expectedVersion) throw new HttpError(409, "This cart changed. Review it again before approving.", "RecordChanged");
    const pouch = await getOwnedPouch(deps, order.pouchId, ownerEmail);
    // Auto-pay: decide under the lock on the pouch and order as they are now; no longer eligible stays a draft.
    if (opts.auto && order.status === "draft" && !autoConfirmEligible(pouch, order)) return order;
    const merchant = getMerchant(order.merchantId);
    const demo = order.fulfillment?.via === "demo";
    let payTo = merchant?.payTo;
    if (demo) {
      const operation = order.status === "paying" ? await deps.store.getOperation(`pay:${order.id}`) : undefined;
      if (operation?.kind === "pay" && operation.pouchId === order.pouchId) payTo = order.fulfillment?.demo?.payTo;
      else payTo = await validateDemoCheckout(deps,order);
    }
    if (order.status === "draft" && !isAnyStore(pouch) && !pouch.allowedMerchantIds.includes(order.merchantId)) throw new HttpError(422,"This pouch no longer allows this store. Review its store rules before paying.","MerchantNotAllowed");
    if (!demo && (isCheckoutReference(order) || !merchants.some(m=>m.id===order.merchantId))) throw new HttpError(422, "This is a search estimate, not a payable quote. Check the current price and complete checkout with the retailer. Solpouch has not placed an order.", "WebCheckoutRequired");
    if (!payTo) throw new HttpError(404,"Merchant not found");
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
      ({txSignature}=await deps.vault.pay(pouch,payTo,order.total,order.id));
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
