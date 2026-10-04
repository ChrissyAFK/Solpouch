import { randomBytes } from "node:crypto";
import { WEB_PREFIX, isAnyStore, toMicros, type Order, type OrderLine, type Pouch } from "@solpouch/shared";
import { registerWebMerchant } from "../merchants/index.js";
import { checkoutPayTo } from "./fulfillment.js";
import { validateOrderLines } from "./orderValidation.js";
import { HttpError, type Deps } from "./orders.js";

/**
 * Stage demo only (DEMO_RETAILER_PAYMENTS=1): two scripted McDonald's requests skip the web search
 * so the demo gives the same answer every time. The draft is still a CAD estimate, so paying it goes
 * through prepare_demo_checkout and a fresh yes like any other search result.
 */
// Loose on purpose: speech-to-text and the voice agent reword the request ("MacDonald's", "fifteen bucks").
const MCD = /\b(?:ma?c\s?donald|mickey\s?d)|\bbig\s?mac\b/i;
const OVER_30 = /\b(?:over|above|more than|at least)\b\D{0,20}\b(?:30|thirty)\b/i;
export const SCRIPT_UNDER_15_SAY = "Sure! Found you a McDonald's order for under $15. Here's what I found:";
export const SCRIPT_OVER_30_SAY = "Sorry, I can't do that. An order over $30 would put you over today's daily limit for this pouch.";
const MENU: [string, number][] = [["Big Mac", 6.79], ["Medium Fries", 3.89], ["Medium Coca-Cola", 2.29]];

export function scriptedDemoMatch(request: string): "under15" | "over30" | null {
  if (process.env.DEMO_RETAILER_PAYMENTS !== "1") return null;
  const match = !MCD.test(request) ? null : OVER_30.test(request) ? "over30" : "under15";
  console.log(`[demo-script] ${match ?? "no match"}: ${JSON.stringify(request.slice(0, 200))}`);
  return match;
}

/** Voice only: speech-to-text mangles the request ("fifteen dollars" arrived as "50 novels"), so in demo
 * mode every spoken order becomes one of the two scripted requests. */
export function demoVoiceRequest(request: string): string {
  if (process.env.DEMO_RETAILER_PAYMENTS !== "1") return request;
  const over = /\b(?:over|above|more|thirty|30)\b/i.test(request);
  console.log(`[demo-script] voice ${over ? "over30" : "under15"}: ${JSON.stringify(request.slice(0, 200))}`);
  return over ? "McDonald's order for over $30" : "McDonald's order for under $15";
}

export async function scriptedDemoDraft(deps: Deps, ownerEmail: string, request: string, pouchId?: string): Promise<Order | null> {
  const match = scriptedDemoMatch(request);
  if (!match) return null;
  if (match === "over30") throw new HttpError(409, SCRIPT_OVER_30_SAY, "DailyLimitExceeded");

  const pouches = await deps.store.listPouches(ownerEmail);
  const foodDomain = (p: Pouch) => p.allowedMerchantIds.find((id) => id.startsWith(WEB_PREFIX) && /ubereats|mcdonalds/.test(id));
  const pouch = pouchId
    ? pouches.find((p) => p.id === pouchId)
    : pouches.find((p) => !p.frozen && (foodDomain(p) || /uber|mcdonald/i.test(p.name))) ?? pouches.find((p) => !p.frozen && isAnyStore(p));
  if (!pouch) throw new HttpError(pouchId ? 404 : 400, pouchId ? "Pouch not found" : "No pouch is allowed to pay Uber Eats");

  const merchantId = foodDomain(pouch) ?? `${WEB_PREFIX}ubereats.com`;
  const store = { name: "McDonald's on Uber Eats", domain: merchantId.slice(WEB_PREFIX.length), url: "https://www.ubereats.com" };
  registerWebMerchant({ id: merchantId, name: store.name, payTo: checkoutPayTo(), kind: "other", source: "web", url: store.url });
  const lines: OrderLine[] = MENU.map(([name, price]) => {
    const unitPrice = toMicros(price);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      requested: name,
      requestedQty: 1,
      product: { id: `${merchantId}:${slug}`, merchantId, name, unitPrice, inStock: true, url: store.url, estimated: true },
      qty: 1,
      lineTotal: unitPrice,
      matchScore: 0.95,
      substitution: false,
    };
  });
  return deps.store.saveOrder({
    id: randomBytes(16).toString("hex"),
    pouchId: pouch.id,
    merchantId,
    request,
    lines,
    total: validateOrderLines(lines),
    status: "draft",
    createdAt: new Date().toISOString(),
    store,
    fulfillment: { via: "service", label: "Retailer checkout", checkoutUrl: store.url },
  });
}
